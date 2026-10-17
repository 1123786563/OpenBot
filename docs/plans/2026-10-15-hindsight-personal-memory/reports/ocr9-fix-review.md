# OCR 轮 9 fix 批次独立复审（聚焦 · 只读，收敛前最后一批）

- **审阅人**：OCR 轮 9 fix 复审 Agent（Orca 分派，task_5a6d6bc1728f / ctx_c68b5c9d0238）
- **审阅对象**：`/Users/wuyongjun/trea/OpenBot-hindsight-exec`，HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` + 全部未提交改动
- **基线**：`reports/ocr8-fix-review.md`（OCR 轮 8 复审，23 文件 sha256 全表，其中 sensitivity.ts `69856327…` / memory-sensitivity.test.ts `14ff9335…` / backup.sh `ab12dc1a…` / store.ts 改前值 `c35f6f04…`）+ `reports/ticket-380.md` 与 `reports/ticket-378.md` 末尾《附录：ocr9-fix》（task_fbcbc5902f85）；"reports/" 指 `docs/plans/2026-10-15-hindsight-personal-memory/reports/`
- **背景**：OCR 轮 9 共 8 comments（3 medium / 5 low）。coordinator 裁决 standin 主机名条（c5，`test/gateway-standin.mjs:63`）为**误报不修**；本批实际修复 2 条有效 medium：c3（backup.sh 无 flock 回退锁 PID 复用死锁，deploy 侧）+ c7（store.completeSync 内层敏感静默丢弃，server 侧）。本复审对 c5 裁决做了独立核对（§4），**同意裁决**。
- **纪律**：只读。未 commit/push；未修改任何被审文件（本报告除外）；真实容器零触碰（仅一次只读 `docker ps` 复核：`openbot-hindsight` 全程 `Up 27 hours (healthy)`、`openbot-hs01-378-pg` `Up 27 hours` @5573，配置未动）；锁演练 docker 经 PATH stub 隔离，真实 docker 二进制未在演练中执行；未运行 `iostat -c`；`/tmp` 探针（`/tmp/ocr9rev-drill/`、`/tmp/ocr9rev-standin.log`）用后已删除并复核 **0 残留**。

## 结论速览

| 维度 | 判定 |
| --- | --- |
| 检查点完整性（23 个交付文件 sha256 全表） | **PASS**（20 个未改动文件 == ocr8-fix-review 基线逐字节（含 sensitivity.ts `69856327…`、memory-sensitivity.test.ts `14ff9335…` 保持 ocr8 终值）；3 个本轮改动文件 == 两份 ocr9-fix 附录"改后"值：backup.sh `c5205a2f…`、store.ts `b912b747…`、memory-defaults.integration.test.ts `00f12932…`。**零偏差**，见 §1） |
| 两份报告只追加声明 | **成立**（ticket-378 `head -454` raw == 附录记载改前 `94dad37d…`；ticket-380 `head -539` raw == `bcff89ed…`；ocr8 旧链同法复现——ticket-378 `head -417` raw == `5e227e87…`、ticket-380 `head -500` raw == `cbf210a3…`、ocr7 链 `head -463` 剥 1 换行 == `68f7d1b1…`。双向复现，见 §1c） |
| 变化集 == 预期（3 代码文件 + 2 报告追加） | **PASS**（backup.sh 两字段 PID+lstart 指纹锁全部要素在位且注释同步；store.ts 内层计数 + error 级日志形状与附录逐字一致；测试文件改动恰为 3 处声明（spyOn/getLogger import + 新测试块）；git status 快照 10 tracked M + 11 untracked = 21 行与前轮一致；审阅窗口 mtime 扫描 0 命中（交付文件 mtime ≤ 02:41，早于审阅起点 ~02:52）。**零夹带**，见 §2） |
| medium-K（backup.sh PID 复用死锁，任务判定 K） | **已解决（/tmp/ocr9rev-drill 演练实证；本机无 flock，回退即真实路径）**（5 场景 + 运行中观测全过：活 PID+错 lstart → 偷锁、流程继续到 dump 链；活 PID+匹配 lstart → 拒绝且锁文件逐字节原样；死 PID+旧格式裸 PID → 仍按 stale 偷锁；加测活 PID+旧格式 → 降级拒绝绝不偷锁、死 PID+两字段 → 经典 stale 偷锁；运行中观测偷锁后锁内容为脚本自身两字段形式；docker stub 断言 dump 失败路径 exit 1、marker 触达、EXIT trap 清锁零残留零 .part。见 §3-K） |
| medium-L（completeSync 内层敏感丢弃可观测性，任务判定 L） | **已解决**（静态：`droppedSensitiveInner` 计数、`{ type: "memory-sync-sensitive-dropped-inner", context: { sourceId, droppedSensitiveInner }, timestamp }` 形状、error 级（ingestion 外层为 info 级——内层命中即防线被绕过的语义有注释言明）、载荷仅计数绝无内容；行为：绕过 ingestion 的 completeSync 直调集成测试通过，断言 error 日志 context `{ sourceId, droppedSensitiveInner: 1 }` 且敏感内容未落候选、normal 正常落库。见 §3-L） |
| standin c5 误报裁决独立核对 | **同意 coordinator 裁决**（守卫 `!LOOPBACK_HOSTS.has(host) && !args.includes("--allow-non-loopback")` → `process.exit(2)` 位于 `server.listen` 之前；host 是裸字符串旗标、无任何解析环节，非集合主机名无旗标时根本到不了 listen。行为实证：`--host 0.0.0.0` 与 `--host myhost.example.internal` 无旗标均 exit 2 拒绝，`--host localhost` 才放行。OCR 所述"无旗标绑定"场景与实现相反，见 §4） |
| 测试/类型/语法/Lint（全部亲自复跑） | **PASS**（规范 12 文件套件（ticket-378 §2 :42 反引号码段逐字清单）**105 pass / 0 fail / 439 expect / 12 files**（基线 104/0/436 + 本轮 1 测试 3 断言）；hindsight 两文件 **27/0/62**；`bunx tsc --noEmit` exit 0；`bash -n backup.sh` 通过；biome（store.ts / memory-defaults）唯一 finding 为 store.ts:244 noConsole，经 `git show HEAD` 核对系 HEAD 预存在（HEAD :232，`memory-mirror-error`），不在本批改动行内） |
| 附录哈希表 / F-C1 口径 / Wave 2 五条 low | **一致 / 闭合 / 如实**（3 个"改后"值 + 3 个"改前"值均与实测/基线逐一相符；执行清单即 ticket-378.md :42 反引号内原串 12 文件直接展开；Wave 2 五条 low（c1 health.ts readVersion 空 catch、c2 index.ts:1706 expireStaleCandidates 60s sweep、c4 backup.sh:85 `^[0-9]+$` 不限位数、c6 standin:156 路由双份、c8 store.ts 召回门槛+隐式 unreviewed 组合）逐条对码实质成立且原样未修；1 条行号转写漂移见 F-I1） |
| 新问题引入 | **无 critical / high / medium**（1 info（c8 行号转写漂移）+ 1 备注（本复审首轮 F-C1 提取曾漏剥尾反引号致 11 文件误跑，属审阅侧探针失误、修正后按码段逐字重跑，与本批交付无关）。见 §6） |
| **总体判定** | **PASS** |

---

## 1. 检查点完整性（sha256 全表重算）

### 1a. 20 个未改动文件 == ocr8-fix-review 基线逐字节一致

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
| `deploy/hindsight/docker-compose.yml` | `656efbb0869ffebf664fe6d5c68f8362ff5dc214b67cbb8c9dd8723d2285108a` |
| `deploy/hindsight/.gitignore` | `ad5f630d7c06efea8149b5c965b4b446417a3f71c8b85b320fcad925d2f5c572` |
| `deploy/hindsight/hindsight.env.example` | `8e3d247e68b97bff1148795298835665fa7ceef153e1a62a4e14b274fd576be0` |
| `deploy/hindsight/test/gateway-standin.mjs` | `85852251eed0eac3bb5163f514e800c8b45cbbd9e2b140efb09033b17103a7a8` |
| `deploy/hindsight/README.md` | `ddf476b04c4ae14ffaad30059a5ae4da6e966c5069ae2a729015ed7fb3d792eb` |
| `deploy/hindsight/test/verify-health.ts` | `5a94cfdf0127c3667b3f7895ab1cd792941d2296a3421917c252feaa579e812a` |
| `server/src/hindsight/health.ts` | `36d0c67d5a76ab575b222c2bfa6e7cb2c29dd9049659de2537d8b5d9b3c3c86f` |
| `server/tests/hindsight-health.test.ts` | `2f78d83d4f953b0cfe036329de85a48170c1621a37887f196447f3a32d0346d4` |
| `server/src/memory/sensitivity.ts` | `69856327ec7dc65e36b1222aa9362ffa8c9df8e1ef99d65243229a133b60da8d`（保持 ocr8 终值） |
| `server/tests/memory-sensitivity.test.ts` | `14ff9335c29c341aca4e8d3b338eecab8ef8a00a2beb9ce7fb2c7c4bfd72cda3`（保持 ocr8 终值） |

### 1b. 3 个本轮改动文件 == ocr9-fix 附录"改后"值

| 文件 | 实测 sha256 | 附录改后值 | 附录改前值（== ocr8 基线） |
| --- | --- | --- | --- |
| `deploy/hindsight/backup.sh` | `c5205a2f44c26adf85b563d74e7fcf8d9892440b9afa64dd962892e76b03a104` | 一致 | `ab12dc1a…` ✓ |
| `server/src/memory/store.ts` | `b912b74729b965d7b3fd09cf5d1332c6dadb8189c9c8439a4c80bf4b41becc1d` | 一致 | `c35f6f04…` ✓ |
| `server/tests/memory-defaults.integration.test.ts` | `00f12932406a32d1b018d2be7eefbf52908ff5d1256c0da2e9a6b2fa53d4baff` | 一致 | `dd2d21c4…` ✓ |

### 1c. 两份报告只追加哈希链复核

- **ticket-378.md**（现 487 行）：ocr9 附录标题在第 456 行，`head -454`（raw，含末尾换行）sha256 == 附录记载改前值 `94dad37db30ab6ef3038b36055e01c3a5456feceb94b6f77c8ab417d9926e4a5` ✓；ocr8 链同法复现（`head -417` raw == `5e227e87…` ✓）。
- **ticket-380.md**（现 576 行）：ocr9 附录标题在第 541 行，`head -539`（raw）== 附录记载改前值 `bcff89ed2aae5c6d7ba063eebf649759bda0852077220eff9090eecf1d47fc6e` ✓；ocr8 链（`head -500` raw == `cbf210a3…` ✓）与 ocr7 链（`head -463` 剥恰 1 个末尾换行 == `68f7d1b1…` ✓）均复现。

**隔离卫生**：HEAD 仍 `f0520524`；`git status --porcelain` 恰 21 行（10 tracked M + 11 untracked 路径），与前轮记录快照一致；未 commit/push；审阅窗口 mtime 扫描 0 命中（交付文件 mtime ≤ `2026-10-17 02:41`，早于审阅起点 ~02:52）。

## 2. 变化清单与"无夹带"证明

三个改动文件的精确改前副本无留存（store.ts/memory-defaults 改前值系附录记载 + 基线表），采用"静态通读对声明 + 行为实测 + 20 文件零偏差包围"证法：

- **backup.sh**（c3）：① 锁总注释（:104-117）更新为"stamped with the holder PID and the holder's start time (`ps -o lstart=`)"，stale 条件扩为"holder 不存活（kill-0 + ps 复核）**或** PID 活但当前启动时间与记录不符（PID 复用）"，并保留空读重试语义句。② `try_create_lock()`（:123-137）：`ps -p $$ -o lstart=` 读自身启动时间、两侧规整空白后与 PID 一起 `printf '%s %s\n'` 写入；lstart 不可得回退 `echo "$$"` 旧单字段形式，注释言明"裸 PID 不是损坏"。③ holder 分支（:195-216）：`LOCK_LSTART="${LOCK_HOLDER#* }"`（无空格即置空）、记录值与当前值双侧 trim；活 PID 分支内三条件与（记录非空 ∧ 当前非空 ∧ 不等）才判"recycled PID"偷锁，否则照旧拒绝（拒绝文案不变）；偷锁后 `try_create_lock` 失败有"just claimed"大声拒绝；死 PID 分支（:218-）不变，兼容旧格式。空读重试（10 次 → 大声拒绝）与 flock 路径（含 `echo "$$" >&9`）原样未动（flock 分支哈希面包围在整文件内、逻辑逐行对读无 diff 迹象）。域校验/引号 CR 剥离/10# 重基/sweep 两条 `-maxdepth 1` find/dump 链/shape-check 均不在本轮声明 delta 内。
- **store.ts**（c7）：`completeSync` 事务内 continue 分支（:817-820）由静默改为 `droppedSensitiveInner += 1`；循环后（:848-856）`if (droppedSensitiveInner > 0) log.error({ type: "memory-sync-sensitive-dropped-inner", context: { sourceId, droppedSensitiveInner }, timestamp: … }, "memory-sync-sensitive-dropped-inner")`；`log = getLogger("server")`（:43）。注释块（:809-813）言明双层防御内层语义、ingestion 预过滤后其计数是 healthy flow 唯一信号、completeSync 是公开方法存在绕过路径（测试中已有）、内层命中即上游防线被绕过故 error 级且"count only, never content"。ingestion 侧外层判定/日志（info 级 `memory-sync-sensitive-dropped`）原样未动（ingestion.ts 哈希 == 基线即证，收敛留 Wave 2）。
- **memory-defaults.integration.test.ts**（c7 测试面）：恰 3 处声明——`spyOn` 并入 :1 bun:test import、:4 新增 `getLogger` import、:330-372 新增 1 个测试块；其余既有测试原样保留（文件级哈希与附录改后值一致即证）。
- **夹带穷尽核查**：`git status` 快照 21 行与前轮一致；20 个未改动交付文件哈希零偏差；审阅窗口 mtime 扫描 0 命中。**预期外交付物改动：0**。

## 3. 两条有效 medium 有效性判定（任务指定 K / L）

### medium-K：无 flock 回退锁的 PID 复用死锁（backup.sh）— **已解决（/tmp/ocr9rev-drill 演练实证；已清理）**

本机 stock macOS 无 `flock`（`command -v flock` 为空），无 flock 回退即真实路径。演练目录副本 + PATH 前置 docker stub（触 marker、打印 `DRILL-DUMP-REACHED` 到 stderr 后 exit 1；真实 docker 未执行）+ 声明 env `HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS=7`。探针：`sleep 300`（存活 PID 64172，实测 lstart `Sat Oct 17 02:56:54 2026`，本机输出带前后空白——顺带实测 trim 路径）、`sleep 0` 已退出探针（PID 64181，`kill -0`/`ps -p` 双复核确死）。

- **S1 活 PID + 错 lstart（复用形态）→ 偷锁、流程继续**：锁写 `64172 Wed Dec 25 00:00:00 2019` → 零拒绝文案、**marker 触达**（抵达 dump 链）、exit 1（stub 处）、stdout 0 字节、EXIT trap 清锁后零锁残留、零 `.part` 残留——**本轮修复的目标场景**。
- **S2 活 PID + 匹配 lstart → 拒绝且锁文件原样**：锁写 `64172 Sat Oct 17 02:56:54 2026` → **exit 1**、stderr 恰一行 `refusing to run: another backup (pid 64172) is holding /tmp/ocr9rev-drill/backups/.backup.lock; overlapping runs are not started`、**锁文件 `cmp` 逐字节一致**、marker=0（未抵达 dump 链）。
- **S3 死 PID + 旧格式裸 PID（单字段）→ 仍按 stale 偷锁**：锁写裸 `64181` → 零拒绝文案、marker=1——旧格式兼容按声明成立。
- **S4（加测）活 PID + 旧格式裸 PID → 降级拒绝、绝不偷锁**：锁写裸 `64172` → exit 1 拒绝、锁文件 `cmp` 逐字节一致、marker=0——"复用无法证明时拒绝"承诺实测成立。
- **S5（加测）死 PID + 两字段 → 经典 stale 偷锁**：marker=1、零拒绝文案、零残留。
- **运行中观测（S1 变体 + 睡眠 stub）**：偷锁后 0.7s 读锁文件，内容已换为脚本自身两字段形式 `66592 Sat Oct 17 02:57:45 2026`（脚本存活 PID + 其 lstart），随后 exit 1、trap 清锁零残留——`try_create_lock` 两字段写入路径实测。
- **docker stub 断言 dump 失败路径**：偷锁场景均在 stub 处 exit 1（`set -e` 链）、marker 先行触达证明 sweep 已照跑、stdout 0 字节、无半成品残留。
- **诚实记录**：首轮演练 harness 的 `run()` 误在运行前删除预置锁文件，S2/S4 首轮结果无效已整体作废；修正 harness（预置锁后不再触碰）后全量重跑，以上为修正后结果。审阅侧失误，与交付无关。

### medium-L：completeSync 内层敏感静默丢弃补计数与日志（store.ts）— **已解决**

- **静态**：`droppedSensitiveInner` 计数（:814，continue 分支 :819 递增）；循环后 `log.error` 输出 `{ type: "memory-sync-sensitive-dropped-inner", context: { sourceId, droppedSensitiveInner }, timestamp }`（:848-856）——载荷仅 sourceId 与计数、**绝无记录内容**；error 级与 ingestion 外层 info 级形成层级（注释言明理由：内层命中即上游防线被绕过的信号；ingestion 预过滤后内层计数是 healthy flow 唯一信号，healthy flow 不应出现内层命中）。注释与附录声明的防线层级语义逐句一致。
- **行为（绕过 ingestion 的直调路径）**：新集成测试 `a direct completeSync call that bypasses ingestion still drops sensitive records and says so`（memory-defaults.integration.test.ts :330-372）在 12 文件套件与单文件复跑中均通过——直调 `completeSync` 传入 1 条 credential（"Staging admin password: hunter2"）+ 1 条 normal，`spyOn(getLogger("server"), "error")` 捕获断言 payload `toMatchObject({ context: { sourceId: id, droppedSensitiveInner: 1 } })`（类型 `memory-sync-sensitive-dropped-inner` 由 find 过滤器保证），并断言敏感内容**未落库**、normal 内容正常落库。沿用了本仓库既有 spyOn logger 惯例。

## 4. standin c5 误报裁决的独立核对 — **同意 coordinator 裁决（误报，不修）**

- **代码核对**（deploy/hindsight/test/gateway-standin.mjs）：`host = readFlagValue("--host") ?? "127.0.0.1"`（:55）是裸字符串旗标，全程无 DNS/解析环节；守卫 `if (!LOOPBACK_HOSTS.has(host) && !args.includes("--allow-non-loopback")) { console.error(…); process.exit(2); }`（:64-73）位于 `server.listen(port, host, …)`（:162）**之前**。`LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])`（:63）为精确字符串集合匹配。因此**任何非集合主机名在无旗标时根本到不了 listen**，不存在 OCR 所述"无旗标解析后静默绑定非回环"的路径；唯一非回环绑定通道是显式 `--allow-non-loopback` 旗标（文档化的操作员显式 opt-in，头注 :23-28 言明）。OCR 对实现的描述与实际相反。
- **行为实证**（审阅窗口内本工作区副本，退出前无任何绑定）：`--host 0.0.0.0` 无旗标 → exit 2 + 拒绝文案；`--host myhost.example.internal` 无旗标 → exit 2；`--host localhost`（集合内）→ 正常进入 listen 后由审阅方 kill。探针日志已删。
- **结论**：**同意**"非集合主机名本就被字符串集合守卫拒绝（无解析环节）、不存在绕过面、无需旗标化改造"的裁决；该条按误报归档、不改代码的处理正确。

## 5. 亲自复跑验证（全部在本审阅执行）

| 项 | 命令/方法 | 结果 | 期望 |
| --- | --- | --- | --- |
| 规范 12 文件套件 | `cd server && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test bun test $(ticket-378.md :42 反引号码段 12 文件原串)`（容器 `openbot-hs01-378-pg` Up 27h @5573） | **105 pass / 0 fail / 439 expect / 12 files**（1.65s 一次通过） | 105/0/439 ✓ |
| hindsight 2 文件 | `TEST_DATABASE_URL=… bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` | **27 pass / 0 fail / 62 expect** | 27/0/62 ✓ |
| 新测试单文件定位 | 同 env `bun test ./tests/memory-defaults.integration.test.ts` | 全过，含 `a direct completeSync call that bypasses ingestion still drops sensitive records and says so` | ✓ |
| 类型检查 | `cd server && bunx tsc --noEmit` | exit 0 | ✓ |
| 语法检查 | `bash -n deploy/hindsight/backup.sh`（真实文件与演练副本各一次） | 通过 | ✓ |
| Lint | `bunx biome check server/src/memory/store.ts server/tests/memory-defaults.integration.test.ts` | 唯一 finding `store.ts:244` noConsole；`git show HEAD:server/src/memory/store.ts` 核对 HEAD :232 同一 `memory-mirror-error` console.error——**HEAD 预存在**，不在本批改动行内（本批改动在 :809-856） | ✓（附录口径一致） |
| 锁演练（medium-K） | /tmp/ocr9rev-drill 5 场景 + 运行中观测 + stub dump 失败断言（§3-K） | 全断言过 | ✓ |
| standin 守卫行为（c5） | 无旗标非集合主机 ×2 → exit 2；集合内主机 → 放行（§4） | 与裁决一致 | ✓ |
| 附录哈希表 | 3 个"改后"值 vs 实测、3 个"改前"值 vs 基线/链条 | 逐一一致 | ✓ |
| 两报告只追加链 | `head -454`/`head -539` raw + ocr8/ocr7 旧链复算 | `94dad37d…` ✓ / `bcff89ed…` ✓（旧链 `5e227e87…`/`cbf210a3…`/`68f7d1b1…` ✓） | ✓ |
| F-C1 口径 | `sed -n '42p' ticket-378.md` 提取反引号内 `bun test` 后原串（12 文件）→ 直接作为执行参数 | 构造上逐字一致（未替换、未增删任何文件） | ✓ |
| Wave 2 五条 low 对码 | server 3 条（ticket-378）+ deploy 2 条（ticket-380）逐条对文件 | 实质全部成立且原样未修（1 条行号漂移见 F-I1） | ✓ |
| 探针清理 | `rm -rf /tmp/ocr9rev-drill`、删 `/tmp/ocr9rev-standin.log`；复核 | 0 残留 | ✓ |
| 真实容器复核 | `docker ps`（只读，一次） | `openbot-hindsight` Up 27 hours (healthy)、`openbot-hs01-378-pg` Up 27 hours @5573，配置零改动 | ✓ |

## 6. Findings（无 critical / high / medium）

| # | 级别 | 发现 | 建议 |
| --- | --- | --- | --- |
| F-I1 | info | ticket-378 附录 Wave 2 第 3 条记 `server/src/memory/store.ts:805`（c8，召回门槛 + 隐式 unreviewed 默认组合效应），:805 现为 completeSync 区域（`if (!source) throw new MemoryNotFoundError();` 附近），非召回门槛所在——实际对应代码在 :340（召回仅取 `reviewState IN ('confirmed','edited')`）与 :463（导入默认 `unreviewed`）。与 ocr8 轮 F-I1/F-H1 同类：OCR 工具对改前快照给出的行号被忠实转写；条目**实质**（升级后存量导入记忆整体静默退出召回，行为按规格 #377）对码成立且原样未修 | Wave 2 执行时以届时实际行号为准；与 F-H1/F-I1 一并校正 |
| 备注-1 | — | 本复审首轮 F-C1 清单提取未剥行尾反引号，误以 11 文件跑出 94/0/382；发现后改用反引号码段精确提取重跑得规范 105/0/439。属审阅侧探针失误，已如实记录，与交付质量无关 | 无需动作 |

## 7. 总体判定

**PASS。** OCR 轮 9 修复批次（2 条有效 medium）经独立复跑全部证实真正解决：backup.sh 两字段 PID+lstart 指纹锁经 /tmp 演练 5 场景 + 运行中观测实证——活 PID+错 lstart（复用形态）被偷锁且流程照常抵达 dump 链、活 PID+匹配 lstart 被拒且锁文件逐字节原样、死 PID 旧格式裸 PID 仍按 stale 偷锁、活 PID 旧格式降级拒绝绝不偷锁、偷锁后锁内容为脚本自身两字段形式、stub 断言 dump 失败路径与 EXIT trap 零残留；store.ts 内层敏感丢弃补 `droppedSensitiveInner` 计数与 error 级 `memory-sync-sensitive-dropped-inner` 日志，载荷仅计数绝无内容，绕过 ingestion 的直调集成测试通过并断言日志形状与落库行为。standin c5 条经代码 + 行为独立核对，**同意 coordinator 误报裁决**（非集合主机名无旗标在 listen 前即被字符串集合守卫 exit 2，OCR 所述场景与实现相反）。23 文件 sha256 全表零偏差（sensitivity.ts/memory-sensitivity.test.ts 保持 ocr8 终值），变化集恰为 3 代码文件 + 2 报告只追加（改前哈希链与 ocr7/ocr8 旧链双向复现），零夹带；规范 12 文件套件（F-C1 反引号码段逐字清单）105/0/439、hindsight 27/0/62、tsc 0、bash -n 通过、biome 唯一 finding 系 HEAD 预存在 noConsole；Wave 2 五条 low 逐条对码如实且原样未修。仅 1 info（c8 行号转写漂移，与 ocr8 轮 F-I1 同类）+ 1 条审阅侧备注，无阻塞。工作区隔离卫生（HEAD 不变、git status 不变、真实容器零触碰、/tmp 探针全清、审阅窗口 mtime 0 命中、未运行 iostat -c、未 commit/push）。**Hindsight Wave 1 收敛前最后一批修复可收敛。**

— 审阅完成于只读工作区，未改动任何被审文件（本报告除外），未 commit/push。
