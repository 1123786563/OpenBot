# OCR 轮 10 fix 批次独立复审（聚焦 · 只读，冻结前最后一批）

- **审阅人**：OCR 轮 10 fix 复审 Agent（Orca 分派，task_057bb704449e / ctx_098c9e8d486b）
- **审阅对象**：`/Users/wuyongjun/trea/OpenBot-hindsight-exec`，HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` + 全部未提交改动
- **基线**：`reports/ocr9-fix-review.md`（OCR 轮 9 复审，23 文件 sha256 全表，其中 backup.sh `c5205a2f…` / docker-compose.yml `656efbb0…`）+ `reports/ticket-380.md` 末尾《附录：ocr10-fix》（task_c27349378543）；"reports/" 指 `docs/plans/2026-10-15-hindsight-personal-memory/reports/`
- **背景**：OCR 轮 10 共 12 comments（2 medium / 10 low）。本轮修 2 medium：α（backup.sh flock 分支与创建式锁互盲，c3）+ β（docker-compose.yml 头注与 r8 修正后的三层真相矛盾，c9）；10 low 记 Wave 2 不修。本复审为冻结前最后一批复审。
- **纪律**：只读。未 commit/push；未修改任何被审文件（本报告除外）；真实容器零触碰（仅一次只读 `docker ps` 复核：`openbot-hindsight` 全程 `Up 37 hours (healthy)`、`openbot-hs01-378-pg` `Up 37 hours` @5573，配置未动；compose 校验仅在 /tmp 沙箱以 `config -q` 只读形式运行）；锁演练 docker 经 PATH stub 隔离、flock 经 shim 隔离，真实 docker/flock 二进制未在演练中执行；未运行 `iostat -c`；`/tmp` 探针（`/tmp/ocr10rev-drill/`、`/tmp/ocr10rev-compose-check/`）用后已删除并复核 **0 残留**。

## 结论速览

| 维度 | 判定 |
| --- | --- |
| 检查点完整性（23 个交付文件 sha256 全表） | **PASS**（21 个未改动文件 == ocr9-fix-review 基线逐字节（store.ts `b912b747…`、memory-defaults `00f12932…` 保持 ocr9 终值）；2 个本轮改动文件 == ocr10-fix 附录"改后"值：backup.sh `f98b0b8f…`、docker-compose.yml `26bbfe28…`，其记载改前值 `c5205a2f…`/`656efbb0…` 亦与 ocr9 基线逐一吻合。**零偏差**，见 §1） |
| 报告只追加声明 | **成立**（ticket-380 现 625 行，ocr10 附录标题在 :578，`head -576` raw sha256 == 附录记载改前值 `dc0097e7…` ✓；ocr9 旧链 `head -539` raw == `bcff89ed…` ✓ 双向复现，见 §1c） |
| 变化集 == 预期（2 文件 + 1 报告追加） | **PASS**（git status 恰 21 行与前轮一致；审阅窗口 mtime 扫描 0 命中（改动文件 mtime 12:37，早于审阅起点 12:52:52）；backup.sh 静态通读：flock 分支四要素与三注释点全部在位、无 flock 创建式路径与 ocr9 基线描述逐句吻合无夹带迹象；docker-compose.yml 头注 10–16 行换为三层表述、其余区段未动。**零夹带**，见 §2） |
| medium-α（backup.sh flock 分支与创建式锁互盲） | **已解决（/tmp/ocr10rev-drill 演练实证，8 场景 39 断言全过；已清理）**：活指纹（PID+真实 lstart）→ `mixed lock styles` 响亮拒绝且锁逐字节原样、拒绝发生在 flock 之前（shim 零留痕）；死 PID 两字段指纹 → fall-through 放行、锁重写为本运行两字段指纹（与 `printf '%s %s\n' PID lstart` 规范形逐字节 cmp 同一）、dump 链触达、退出后锁文件保留（flock 式设计语义）；PID 复用形态（活 PID+错 lstart）→ fall-through 放行；空/杂乱内容 → 均继续；创建式三态回归（真活拒绝/复用偷锁/旧格式死 PID 偷锁）行为与 ocr9 基线一致；反向混用（两字段活指纹被无 flock 运行读到）→ 走既有拒绝路径，两种风格双向互斥闭合。见 §3 |
| medium-β（compose 头注三层真相） | **已解决**（头注 10–16 行为如实三层表述含 #391 指向；`grep agree` 零命中——旧 "agree" 句式已除；静态核对 `server/src/hindsight/config.ts`：`loadHindsightConfig(env = process.env)` 只读进程 env、全文件无任何读 hindsight.env 的代码路径，健康检查 privacy 配置仅经 `validateHindsightPrivacy(config.privacy)` 取自该 config——与头注 "never reads hindsight.env" 一致；/tmp 沙箱 `cp hindsight.env.example hindsight.env` + `docker compose config -q` → exit 0（Compose v5.5.0），沙箱用后已删。见 §4） |
| 测试/类型/语法/Lint（全部亲自复跑） | **PASS**（规范 12 文件套件（ticket-378 §2 :42 反引号码段逐字清单）**105 pass / 0 fail / 439 expect / 12 files**；hindsight 两文件 **27/0/62**；`bunx tsc --noEmit` exit 0；`bash -n backup.sh` 通过；`shellcheck -S warning` 0 findings——与附录记载一致。server 侧本轮零字节改动，lint 面不变） |
| 附录哈希表 / F-C1 口径 / Wave 2 十条 low | **一致 / 闭合 / 如实**（2 个"改后"值 == 实测、2 个"改前"值 == ocr9 基线、ticket-380 改前值 == head 链实测；执行清单即 ticket-378.md :42 反引号内 `bun test` 后原串 12 文件直接展开；Wave 2 十条 low 抽查 9 条对码，行号全部准确、实质成立且原样未修，见 §6-F-O1） |
| 新问题引入 | **无 critical / high / medium / info**（仅 1 条审阅侧备注：本轮探针 harness v1 缺陷致首轮部分结果无效，v2 隔离后全量重跑，与交付无关，见备注-1） |
| **总体判定** | **PASS** |

---

## 1. 检查点完整性（sha256 全表重算）

### 1a. 21 个未改动文件 == ocr9-fix-review 基线逐字节一致

| 文件 | 实测 sha256 |
| --- | --- |
| `server/src/index.ts` | `21f9fd8c007796904456303c99fb76297910b3b4890e8a4dd674c4060884a116` |
| `server/src/hindsight/config.ts` | `6ce1b396a0e0476778b8fae76b09a73bf2628e86ea5ff97b793554ee1f69931c` |
| `server/tests/hindsight-config.test.ts` | `783c9542b378ebd767caa7ca94da48c85f5ced36bacae07d7d80437f97ad87eb` |
| `server/src/memory/ingestion.ts` | `0d13d16a0cb65603a97f7791095ecf62f2a55da2052bb67a86da6f104eaf9687` |
| `server/src/memory/tools.ts` | `93fa491b1ceb4e594ff717b8f56c8fd2629f162df58acfce83f6bf8c748ac93f` |
| `server/tests/memory-store.integration.test.ts` | `9a369e8ea79d107b71491264830148bba38a58ea6e97fa3daf1358922a39403e` |
| `server/tests/memory-runtime.test.ts` | `eb4b78f474af174577ce2e289258697d8d840d0e0c741cad62dc520c864b9abc` |
| `server/tests/proactive-store.integration.test.ts` | `4d17689b54048ea9f43d35533990f9c5ffaecd44ee27eb1f04339bf568816fdc` |
| `server/tests/memory-expiry.test.ts` | `f1fc63c9fb2a14d86837295defe99495a7ef615f2a680bb231cd289329c6ae98` |
| `server/tests/memory-intelligence.integration.test.ts` | `fdcce78399ebf5ef808c8ccbccb240862f74122f49cf545c30bdd00911be12d0` |
| `server/src/memory/store.ts` | `b912b74729b965d7b3fd09cf5d1332c6dadb8189c9c8439a4c80bf4b41becc1d`（保持 ocr9 终值） |
| `server/tests/memory-defaults.integration.test.ts` | `00f12932406a32d1b018d2be7eefbf52908ff5d1256c0da2e9a6b2fa53d4baff`（保持 ocr9 终值） |
| `server/src/hindsight/health.ts` | `36d0c67d5a76ab575b222c2bfa6e7cb2c29dd9049659de2537d8b5d9b3c3c86f` |
| `server/tests/hindsight-health.test.ts` | `2f78d83d4f953b0cfe036329de85a48170c1621a37887f196447f3a32d0346d4` |
| `server/src/memory/sensitivity.ts` | `69856327ec7dc65e36b1222aa9362ffa8c9df8e1ef99d65243229a133b60da8d` |
| `server/tests/memory-sensitivity.test.ts` | `14ff9335c29c341aca4e8d3b338eecab8ef8a00a2beb9ce7fb2c7c4bfd72cda3` |
| `deploy/hindsight/.gitignore` | `ad5f630d7c06efea8149b5c965b4b446417a3f71c8b85b320fcad925d2f5c572` |
| `deploy/hindsight/hindsight.env.example` | `8e3d247e68b97bff1148795298835665fa7ceef153e1a62a4e14b274fd576be0` |
| `deploy/hindsight/test/gateway-standin.mjs` | `85852251eed0eac3bb5163f514e800c8b45cbbd9e2b140efb09033b17103a7a8` |
| `deploy/hindsight/README.md` | `ddf476b04c4ae14ffaad30059a5ae4da6e966c5069ae2a729015ed7fb3d792eb` |
| `deploy/hindsight/test/verify-health.ts` | `5a94cfdf0127c3667b3f7895ab1cd792941d2296a3421917c252feaa579e812a` |

### 1b. 2 个本轮改动文件 == ocr10-fix 附录"改后"值

| 文件 | 实测 sha256 | 附录改后值 | 附录改前值（== ocr9 基线） |
| --- | --- | --- | --- |
| `deploy/hindsight/backup.sh` | `f98b0b8fba1a2cba62a262a8257ec428702689005b2d73aee3d0b5cc3c1fa4d3` | 一致 | `c5205a2f…` ✓ |
| `deploy/hindsight/docker-compose.yml` | `26bbfe2810a1ddba7b22fb2dc924c8e523cabe98c9011cbfbc5d519f6fb968fa` | 一致 | `656efbb0…` ✓ |

### 1c. ticket-380 只追加哈希链复核

- **ticket-380.md**（现 625 行）：ocr10 附录标题在第 578 行，`head -576`（raw）sha256 == 附录记载改前值 `dc0097e753ca1de3d4f124858634db683a2666f8083adb13109334b43204bb17` ✓；ocr9 旧链同法复现（`head -539` raw == `bcff89ed2aae5c6d7ba063eebf649759bda0852077220eff9090eecf1d47fc6e` ✓）。

**隔离卫生**：HEAD 仍 `f0520524`；`git status --porcelain` 恰 21 行（10 tracked M + 11 untracked 路径），与前轮记录快照一致；未 commit/push；审阅窗口 mtime 扫描 0 命中（交付文件最新 mtime 为两个本轮改动文件的 `2026-10-17 12:37`，早于审阅起点 12:52:52；其余 ≤ 02:41）。

## 2. 变化清单与"无夹带"证明

两个改动文件的精确改前副本无留存（改前值系附录记载 + ocr9 基线表），采用"静态通读对声明 + 行为实测 + 21 文件零偏差包围"证法：

- **backup.sh**（medium-α）：① flock 分支打开改 `exec 9>>"$LOCK_FILE"`（追加不截断），注释言明 `>` 打开会截断并抹掉既有持有者指纹。② 取 flock 前内容预检：`LOCK_PID="${LOCK_HOLDER%% *}"`，`case` 空/首字段非数字直接 fall-through；数字 PID 经 kill-0 + `ps -p` 复核判活（注释言明 EPERM 语义与创建式同规则）；活 PID 读记录 lstart（无空格置空、双侧 trim）与当前 `ps -o lstart=` 比对，**仅当记录与当前均非空且不等（复用形态）才 fall-through，否则响亮拒绝** `mixed lock styles detected`（文案含 pid 与手工清陈锁提示）。③ `flock -n 9` 失败有独立响亮拒绝（flock 式文案）；成功后 `printf '%s %s\n' "$$" "$_run_lstart" > "$LOCK_FILE"` 重写为本运行两字段指纹（lstart 不可得回退单字段，同创建式降级），注释言明截断此刻安全（两风格都只在取锁前看内容）。④ 注释三点齐备：flock 仅在 flock 用户间提供内核互斥；内容检查覆盖同一备份目录上不同供给运行的单主机混用；跨主机共享目录时 PID/lstart 是主机本地的、跨主机互斥依赖共享文件系统上的 flock。⑤ 无 flock 创建式路径（try_create_lock 两字段+trim+单字段降级、holder 分支 EPERM/ESRCH 注释、PID 复用三条件与偷锁、just claimed 响亮拒绝、空读 10 次重试、EXIT trap 按 `LOCK_STYLE = create` 条件清锁、flock 式锁有意保留）与 ocr9-fix-review §2 逐句吻合，无改动迹象；域校验/10# 重基/sweep 两条 `-maxdepth 1` find/dump 链/shape-check/stdin 传密均不在本轮声明 delta 内。
- **docker-compose.yml**（medium-β）：头注 10–16 行换为三层如实表述（backup.sh 双层声明 / OpenBot 健康检查只读 OpenBot 部署环境 `HINDSIGHT_PRIVACY_*` 且 **never reads hindsight.env** / 仅 hindsight.env 声明时备份照跑而健康检查仍报 noncompliant / 两侧对齐属部署对账任务 **#391**）；其余区段（镜像 pin、loopback 端口、9999 不发布、healthcheck、extra_hosts 等）与 ocr9 基线内容一致。
- **夹带穷尽核查**：`git status` 快照 21 行与前轮一致；21 个未改动交付文件哈希零偏差；审阅窗口 mtime 扫描 0 命中。**预期外交付物改动：0**。

## 3. medium-α 有效性判定（backup.sh flock 分支与创建式锁互盲）— **已解决（/tmp/ocr10rev-drill 演练实证；已清理）**

审阅环境：stock macOS 无真实 flock（`command -v flock` 为空）。演练目录：改后脚本副本 + `stubs/`（flock shim：`flock -n 9` 恒成功并留痕 FLOCK_SHIM_LOG；docker stub：触 marker、打印 `DRILL-DUMP-REACHED` 到 stderr、sleep 1 后 exit 1——真实 docker 未执行）+ `stubs-noflock/`（仅 docker stub；无 shim 时创建式即真实路径）+ 声明 env `HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS=30`。共 8 场景 39 断言：

- **α1 活指纹 → 响亮拒绝（mixed lock styles）**：锁写活探针 `sleep 300` PID + 其实测 lstart → exit 1、stderr 恰含 `refusing to run: mixed lock styles detected — … (pid <探针>) …` 与手工清陈锁提示、锁文件 `cmp` 逐字节原样、marker 不存在（未抵达 dump 链）、**shim 留痕为空——拒绝发生在 flock 之前**（规格②前置内容检查按声明生效）。
- **α2 死 PID 两字段指纹 → fall-through 放行 + 锁重写为本运行指纹**：探针先取真实 lstart 再终止（kill-0/ps 双复核确死），锁写两字段 → 运行中观测（stub sleep 1 留窗）：锁文件为**存活**两字段指纹且与 `printf '%s %s\n' <锁PID> <ps 实测 lstart>` 逐字节 cmp 一致（与创建式规范形同构）；运行结束 exit 1（stub 处）、marker 触达（sweep 先照跑）、shim 恰调用 1 次、stderr 零拒绝文案、退出后锁文件保留且内容不变（flock 式锁有意保留的注释语义实测）。
- **α3 PID 复用形态（活 PID + 错 lstart）→ fall-through 放行**：锁写活探针 PID + `Wed Dec 25 00:00:00 2019` → 零 mixed 拒绝、运行中锁已被重写为存活两字段指纹、marker 触达、shim 1 次——活指纹的 lstart 豁免分支实测。
- **α4a/α4b 空 / 杂乱（首字段非数字）内容 → 均继续**：抵达 dump 链、无拒绝、shim 1 次——规格②"死/空/杂乱 fall-through"全分支覆盖。
- **C1 创建式真活拒绝（两字段活指纹）→ 既有拒绝路径**：无 shim PATH 下 exit 1、`refusing to run: another backup (pid …) is holding`、锁逐字节原样、marker 不存在、stderr 无 mixed 文案（创建式路径文案未被波及）。**该场景同时即反向混用**：flock 式运行写下的两字段活指纹被无 flock 运行读到 → 走既有拒绝路径（宁误拒），两种风格在同一活指纹上双向互斥闭合。
- **C2 创建式复用偷锁**（活 PID + 伪造 2019）→ 零拒绝、marker 触达、EXIT trap 清锁零残留、零 `.part`。
- **C3 创建式旧格式死 PID 偷锁**（裸单字段）→ 零拒绝、marker 触达、锁清除。
- 创建式三态结论与 ocr9 基线一致，行为不变。

## 4. medium-β 有效性判定（compose 头注三层真相矛盾）— **已解决**

- **头注静态核对**：docker-compose.yml 头注 10–16 行现为三层如实表述——backup.sh 接受进程 env 或脚本旁 hindsight.env 的显式声明；OpenBot 隐私健康检查只读 OpenBot 部署环境的 `HINDSIGHT_PRIVACY_*`、**"it never reads hindsight.env"**；仅在 hindsight.env 声明时备份任务照跑而健康检查仍报 noncompliant；两侧对齐属部署对账任务（**#391**）。
- **与 config.ts 实际读取范围核对**：`server/src/hindsight/config.ts` 的 `loadHindsightConfig(env: Record<string, string | undefined> = process.env)` 只读传入 env（生产路径即进程 env）；全文件对 `hindsight.env` 的引用仅一处头注（说明 Hindsight 本体配置来源），无任何文件读取代码路径（无 readFileSync/dotenv）。健康检查侧 `server/src/hindsight/health.ts` 的 privacy 合规判定走 `validateHindsightPrivacy(config.privacy)`，config 生产来源即 `loadHindsightConfig`。**头注表述与实现一致**。
- **旧句式清除**：`grep -n "agree" deploy/hindsight/docker-compose.yml` → 零命中。
- **compose 语法校验**：/tmp 沙箱（compose 副本 + `hindsight.env.example` 具名为 hindsight.env）`docker compose -f … config -q` → **exit 0**（Docker Compose v5.5.0）；仓库目录内未运行任何 compose 命令，沙箱用后已删。

## 5. 亲自复跑验证（全部在本审阅执行）

| 项 | 命令/方法 | 结果 | 期望 |
| --- | --- | --- | --- |
| 规范 12 文件套件 | `cd server && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test bun test $(ticket-378.md :42 反引号码段 12 文件原串)`（容器 `openbot-hs01-378-pg` Up 37h @5573） | **105 pass / 0 fail / 439 expect / 12 files**（4.72s 一次通过） | 105/0/439 ✓ |
| hindsight 2 文件 | 同 env `bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` | **27 pass / 0 fail / 62 expect / 2 files** | 27/0/62 ✓ |
| 类型检查 | `cd server && bunx tsc --noEmit` | exit 0 | ✓ |
| 语法检查 | `bash -n deploy/hindsight/backup.sh`（真实文件） | 通过 | ✓ |
| Shell Lint | `shellcheck -S warning deploy/hindsight/backup.sh` | 0 findings | ✓（与附录一致） |
| flock 分支演练（medium-α） | /tmp/ocr10rev-drill 8 场景 39 断言（§3） | 全断言过 | ✓ |
| compose 头注 vs config.ts（medium-β） | 静态核对 + grep + 沙箱 config -q（§4） | 全部一致 | ✓ |
| 附录哈希表 | 2 个"改后"值 vs 实测、2 个"改前"值 vs ocr9 基线、ticket-380 改前值 vs head 链 | 逐一一致 | ✓ |
| 报告只追加链 | `head -576` raw == `dc0097e7…`、旧链 `head -539` == `bcff89ed…` | 双向复现 | ✓ |
| F-C1 口径 | `sed -n '42p' ticket-378.md` 提取反引号内 `bun test` 后原串（12 文件）→ 直接作为执行参数 | 构造上逐字一致（未替换、未增删任何文件） | ✓ |
| Wave 2 十条 low 对码 | 抽查 9 条逐条对文件（§6-F-O1） | 行号全部准确、实质成立且原样未修 | ✓ |
| 探针清理 | `rm -rf /tmp/ocr10rev-drill`、`rm -rf /tmp/ocr10rev-compose-check`；复核 | 0 残留 | ✓ |
| 真实容器复核 | `docker ps`（只读，一次） | `openbot-hindsight` Up 37 hours (healthy)、`openbot-hs01-378-pg` Up 37 hours @5573，配置零改动 | ✓ |

## 6. Findings（无 critical / high / medium / info）

| # | 级别 | 发现 | 建议 |
| --- | --- | --- | --- |
| F-O1 | 观察（非缺陷） | ocr10 附录 Wave 2 十条 low 抽查 9 条（server 侧 5 + deploy 侧 4）对码：行号全部准确（含 `backup.sh:85` 保留期正则——恰在校验区、未受 flock 分支新增行下移影响；`sensitivity.ts:155-157` catch 兜底 "normal"、`store.ts:53` CANDIDATE_TTL_MS、`store.ts:337-340` confirmed/edited 过滤、`health.ts:245-253` gateway probe warn、`standin.mjs:146/162-166`、`verify-health.ts:30-31` `scenario in expected`），实质全部成立且原样未修。本轮无 ocr8/ocr9 轮那类行号转写漂移 | Wave 2 执行时以届时实际行号为准 |
| 备注-1 | —（审阅侧） | 本复审探针 harness v1 存在审阅侧缺陷：函数包装后台任务 + `$!` 断言对象错位 + 场景间共享 out/err 文件，且上轮残留后台脚本与新进程交错写同一 stderr 文件产生污染碎片，致首轮 8 断言 FAIL 无效；内联单场景诊断定位根因后，v2 harness（每场景独立输出文件、内联 subshell 后台、脚本身份改由锁文件 + ps 校验）**全量重跑 8 场景 39 断言全过**，残留进程复核 0。属审阅侧脚手架失误，与交付质量无关（与 ocr9 轮备注-1 同类如实记录） | 无需动作 |

## 7. 总体判定

**PASS。** OCR 轮 10 修复批次（deploy 侧 2 medium）经独立复跑全部证实真正解决：backup.sh flock 分支经 /tmp 演练 8 场景 39 断言实证——`exec 9>>` 追加打开不截断、取 flock 前按创建式同规则做内容预检（活指纹响亮拒绝 mixed lock styles 且拒绝发生在 flock 之前、PID 复用形态与死/空/杂乱内容均 fall-through）、flock 成功后锁文件重写为本运行两字段指纹（与创建式规范形逐字节同构）、跨主机边界注释如实；创建式三态回归与 ocr9 基线一致，反向混用双向互斥闭合。docker-compose.yml 头注 10–16 行换为与 config.ts 实际读取范围一致的三层如实表述（含 #391），旧 "agree" 句式零残留，compose config -q 通过。23 文件 sha256 全表零偏差（21 个 == ocr9 基线、2 个 == 附录改后值），变化集恰为 2 文件 + ticket-380 只追加（改前哈希链 `dc0097e7…` 与 ocr9 旧链 `bcff89ed…` 双向复现），零夹带；规范 12 文件套件（F-C1 反引号码段逐字清单）105/0/439、hindsight 27/0/62、tsc 0、bash -n 与 shellcheck -S warning 均通过；Wave 2 十条 low 抽查 9 条行号准确、实质成立且原样未修。无 critical/high/medium/info finding，仅 1 条审阅侧 harness 备注。工作区隔离卫生（HEAD 不变、git status 21 行不变、真实容器零触碰、/tmp 探针与 compose 沙箱全清、审阅窗口 mtime 0 命中、未运行 iostat -c、未 commit/push）。**Hindsight Wave 1 冻结前最后一批修复可收敛。**

— 审阅完成于只读工作区，未改动任何被审文件（本报告除外），未 commit/push。
