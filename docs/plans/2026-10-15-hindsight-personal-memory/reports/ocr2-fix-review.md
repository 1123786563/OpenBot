# OCR 轮 2 fix 批次独立复审（重新执行版 · 只读）

- **审阅人**：OCR 轮 2 fix 复审 Agent（Orca 分派，task_8cbc6914b833 / ctx_c7e8af0a5ea5；前一轮 reviewer 会话卡死，本审阅从头独立执行）
- **审阅对象**：`/Users/wuyongjun/trea/OpenBot-hindsight-exec`，HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` + 全部未提交改动
- **基线**：`reports/ocr-fix-review.md`（OCR 轮 1 复审）+ `reports/ticket-380.md` 附录 ocr-fix 的 sha256 表（"reports/" 指 `docs/plans/2026-10-15-hindsight-personal-memory/reports/`）；参照物含 ticket-380.md 附录 ocr2-fix（wave-1 执行者自述，2026-10-16 10:33）
- **纪律**：只读。未 commit/push，未修改任何被审文件（本报告 + git-ignored 的 `deploy/hindsight/backups/` 运行态产物除外）；探针进程/文件已全部清理。

## 结论速览

| 维度 | 判定 |
| --- | --- |
| 检查点完整性（23 个交付文件 sha256 全表） | **PASS**（wave-1 三文件 == ocr2-fix 附录改后值；其余 19 文件 == 轮 1 基线逐字节；唯一偏差 `backup.sh` b7270f9d… 即 wave-2 改动本体，mtime 10:58 晚于附录 10:33） |
| 变化集 == 预期（health.ts + config.ts + hindsight-config.test.ts + backup.sh；hindsight-health.test.ts 不动） | **PASS**（3 个 ts 文件以轮前副本做**真 diff**，与两轮附录声明之和逐 hunk 对齐、零夹带；backup.sh 无基线字节，以全文审读 + 行为实测 + 哈希链核验，语义全部归属预期修复，见 F-B3 一处无法溯源的良性细节） |
| M1（探针 URL 租户段常量化） | **已解决** |
| M2（loadHindsightConfig 注释如实化） | **已解决** |
| M3（backupRetentionDays 下界 ≥1） | **已解决**（代码 + 新用例 + 测试） |
| M4（instance.json 输出恰 4 行非空校验、零泄漏） | **已解决** |
| M5（RETENTION_DAYS 10# 十进制重基） | **已解决** |
| 附：flock+PID 独占回退（backup.sh 并发守卫） | **已解决**（本审阅行为实测：拒绝路径 exit 1、stale 偷锁、trap 清理、无 flock 自动回退；但发现 1 个 low 级边界缺陷 F-B1） |
| 新问题引入 | **无 critical/high/medium**（1 low + 2 info，见 §5） |
| 测试/类型/语法（全部亲自复跑） | **PASS**（104/0/408 + 23/0/55 + tsc 0 + bash -n + shellcheck 0） |
| 运行态探针（对 openbot-hindsight 真实复跑） | **PASS**（exit 0、retention 30d、0600、gzip -t、57,902 B 真实 dump、.part/锁零残留） |
| **总体判定** | **PASS** |

---

## 1. 检查点完整性（sha256 全表重算）

对审阅工作区全部 23 个交付文件逐一重算 sha256：

**与 ticket-380 附录 ocr2-fix"改后"值逐字节一致的 3 个 wave-1 文件**：

| 文件 | 本次实测 | ocr2-fix 附录改后值 |
| --- | --- | --- |
| `server/src/hindsight/health.ts` | `e619eebf…d06c8ff6` | 一致 |
| `server/src/hindsight/config.ts` | `59c72eac…320db956` | 一致 |
| `server/tests/hindsight-config.test.ts` | `783c9542…f97ad87eb` | 一致 |

**与轮 1 基线（ocr-fix 附录 / ocr-fix-review §1）逐字节一致的 19 个文件**：

- hs01 侧 13 文件：`memory-store.integration.test.ts 9a369e8e…`、`memory-runtime.test.ts eb4b78f4…`、`memory-defaults.integration.test.ts dd2d21c4…`、`proactive-store.integration.test.ts 4d17689b…`、`memory/sensitivity.ts 18dc2d9a…`、`memory/store.ts c35f6f04…`、`memory/ingestion.ts 0d13d16a…`、`memory/tools.ts 93fa491b…`、`index.ts ceb5e581…`、`memory-sensitivity.test.ts 0701544d…`、`memory-expiry.test.ts f1fc63c9…`、`memory-intelligence.integration.test.ts fdcce783…`、`hindsight-health.test.ts f6fc21d6…`（该文件轮 2 未改动 —— 与任务预期一致，deps 回退用例系轮 1 既有）
- hs03 侧 6 文件：`docker-compose.yml 656efbb0…`、`README.md e4e8ac87…`、`hindsight.env.example d109e9f7…`、`.gitignore ad5f630d…`、`test/gateway-standin.mjs 9fd4baed…`、`test/verify-health.ts dff17709…`

**唯一偏差**：`deploy/hindsight/backup.sh` = `b7270f9d54b2c2a3a7b669f88aea457007535cb047d737773ebceb45e6dc8cbf` ≠ 轮 1 基线 `538d0fc4…`，mtime `2026-10-16 10:58`（晚于 ocr2-fix 附录 10:33）。即 **wave-2（M4/M5/flock）改动已落盘，但 ticket-380.md 尚无对应附录记录**（见 F-B2）。该偏差本身即任务预期的 wave-2 变化集，非预期外改动。

**隔离卫生**：`git status` 与审阅前记录完全一致（10 tracked M + 11 untracked，无新增条目）；HEAD 仍 `f0520524`；复审产生的备份产物全部落在 git-ignored 的 `deploy/hindsight/backups/`（`.gitignore:2` 实测命中）。

## 2. 变化清单与"无夹带"证明

### 2a. 三个 ts 文件 —— 轮前副本真 diff（决定性证据）

`hs03-selfhost-service` worktree 保有轮前副本：`health.ts 4ca854ce…`、`config.ts d10aa347…`、`hindsight-config.test.ts 52700e33…`（均 == 轮 1 基线记录值）。对三者做 `diff -u` 到现工作区，**累计 diff（轮 1 + 轮 2 两轮之和）逐 hunk 归属如下，零多余 hunk、零删改**：

| 文件 | 累计 diff hunk | 归属 |
| --- | --- | --- |
| `health.ts`（4ca854ce → e619eebf） | ① 标题 Three-state→Four-state；② 头注路径 `/v1/default/…`→`/v1/{tenant}/…`；③ import `getLogger`+`PrivacyViolationId` + `const log`；④ `HINDSIGHT_TENANT_SEGMENT` 常量 + doc 注释；⑤ `violations?: string[]`→`PrivacyViolationId[]`；⑥ 删 `bank_id?: string`；⑦ deps spread→per-key fallback + 注释；⑧ service_down catch→`catch(error)`+`log.info`；⑨ 探针 URL 改用常量；⑩ gateway catch→`catch(error)`+`log.info` | ①②④⑥⑧⑨ = 轮 2（M1 + Low×3）；③⑤⑦⑩ = 轮 1 附录声明。**两轮之和恰好穷尽** |
| `config.ts`（d10aa347 → 59c72eac） | ① 模块头注 backup 描述补 "at least one … a zero-day backup window is rejected — see MIN_BACKUP_RETENTION_DAYS"；② 字段注释 "At most 30"→"At least 1, at most 30"；③ 新增 `MIN_BACKUP_RETENTION_DAYS = 1` + doc 注释；④ validate backup 分支补 `< MIN_BACKUP_RETENTION_DAYS`；⑤ loadHindsightConfig 注释如实化（无 server 运行时调用方，接入启动属 #393 后续） | ①–④ = M3；⑤ = M2。**恰为轮 2 wave-1 声明** |
| `hindsight-config.test.ts`（52700e33 → 783c9542） | **纯新增恰 1 个用例**（11 行，"zero-day backup retention is noncompliant, matching backup.sh's 0 refusal"，插入位置在 backup>30 与 missing-声明用例之间），无任何删改/弱化 | = M3 新用例 |

### 2b. backup.sh —— wave-2（538d0fc4 → b7270f9d）

轮 1 后字节在本机无副本，diff-of-diffs 以"现文件全文审读 + 哈希链（基线 ≠ 现值）+ 行为实测"完成（与轮 1 审阅对同文件的方法一致）。全文语义逐段归属：

- **轮 1 既有要素全部保留**：`set -euo pipefail`、`umask 077`、retention 三级解析（宿主 env → 同目录 `hindsight.env` 锚定 sed 末行生效 → 默认 30，引号/CR 容忍）、`1..30` 校验 + 0 显式拒绝（指引文案）、口令经 stdin（`printf | docker compose exec -T sh -c 'IFS= read -r …'`）、隐藏 `.part` + EXIT trap、`gzip -t` 后 `mv`、sweep `N-1` 语义与边界测量注记、cron `mkdir -p` 头注。
- **wave-2 新增（预期修复）**：M4 形状校验、M5 `10#` 重基、flock+PID 独占回退（详 §3）。
- **一处无法溯源的细节（F-B3）**：两条 `docker compose` 调用带 `-f "$HERE/docker-compose.yml"` 显式锚定。轮 1 字节不可得，无法确认是否 wave-2 新增；语义为良性稳健性提升（消除 cwd 依赖与 compose project 推断歧义），无泄漏/回退风险。

**预期外改动：0。**

## 3. 五项 medium + flock 逐项解决判定

### M1（health.ts 探针 URL 租户段常量化）— **已解决**
模块级 `const HINDSIGHT_TENANT_SEGMENT = "default"`，探针 URL `${config.apiUrl}/v1/${HINDSIGHT_TENANT_SEGMENT}/banks/${encodeURIComponent(config.bankId)}/health/llm`；常量 doc 注释写明单租户固定 vs bank id 每部署配置的对称性理由；头注路径记法同步 `/v1/{tenant}/…`。URL 实际值未变（真 diff 佐证：仅构造方式去硬编码），测试断言路由不变。

### M2（loadHindsightConfig 注释如实化）— **已解决**
原注释「misconfigured deployment fails loudly at startup」不实（无 server 运行时调用方）。现注释如实陈述：唯一调用方为测试套件与 `deploy/hindsight/test/verify-health.ts`，接入 server 启动/巡检属 #393（管理员视图）后续，在此之前本模块不构成启动期保证；抛错行为描述（带违规变量名）保留。真 diff 佐证恰 1 个 hunk。

### M3（backupRetentionDays 下界 ≥1）— **已解决**
`MIN_BACKUP_RETENTION_DAYS = 1`（doc 注释写明 0 天窗口不可兑现、与 backup.sh 1..30 域对齐）；validate backup 分支补 `< MIN` 判违规；模块头注与字段注释同步 "At least 1, at most 30"。边界不变项保持：`operationRetentionDays = 0` 仍合规（既有用例 "zero-day operation retention … is compliant" 原样保留并通过）。新单测 `HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS="0"` → `compliant:false` + violations 含 `backup_retention_days`，实测通过。

### M4（instance.json 输出恰 4 行非空校验、零泄漏）— **已解决**
- 容器内 python 按 `installation_dir/version/bin/pg_dump`、username、password、database 顺序输出 4 行；宿主以 `sed -n 1..4p` 逐行提取。
- **校验在一切使用之前**：`grep -c ''` == 4 且四字段逐一 `-z` 非空，否则 `exit 1`。错位防护闭环：field 3 是口令，短读/空行/值内换行（行数 >4）都会在口令进入 `pg_dump --username`（进而进错误输出/日志）之前大声失败。
- **零泄漏**：拒绝文案为固定文本并明示 "the captured output is not printed because it contains the password"；`CONNECTION` 不落 argv、不回显；`printf '%s\n' "$CONNECTION"` 以 `%s` 传值，无格式串注入面。
- 注入面审读：`INSTANCE_JSON` 为脚本内固定字面量，内嵌 python 代码无用户输入。

### M5（RETENTION_DAYS `10#` 十进制重基）— **已解决**
顺序正确：`^[0-9]+$` 锚定 regex（保证纯数字）→ `[ -lt 1 ]`/`[ -gt 30 ]`（`[` 本就十进制，注释亦已说明）→ `RETENTION_DAYS=$((10#$RETENTION_DAYS))` 重基 → 后续 sweep 算术不再受八进制影响。08/09 崩溃（"value too great for base"）与 030→24 静默提前 sweep 两类缺陷均消除；`00` 仍被 1..30 校验拒绝，语义不变。

### 附：flock+PID 独占回退 — **已解决**（附 1 个 low 边界缺陷 F-B1）
- 有 `flock`：`exec 9>` + `flock -n 9`，持锁失败 exit 1；内核随 fd 释放锁，锁文件有意保留（避免删文件竞态，注释已说明）。
- 无 `flock`（stock macOS，本机实测命中）：noclobber 独占创建 + PID 戳；创建失败读 holder——空/非数字（创建者写 PID 前的竞态窗口）重试 10×0.1s 后大声拒绝、**永不误判 stale**；holder 存活 → exit 1 拒绝；holder 已死 → rm + 重新抢占，抢占失败亦拒绝。
- EXIT trap 按 `LOCK_STYLE` 区分清理：仅 create 风格删除锁文件（该值只在本 run 实际持锁时才被赋值），拒绝路径绝不删他人锁；`.part` 一律清理。
- **本审阅行为实测**（macOS，无 flock，全走回退路径）：① 正常跑后锁文件被 trap 清除、零残留；② 预置同用户存活 PID（后台 sleep）→ `refusing to run: another backup (pid 32311) is holding …` + **exit 1**，锁文件未被误删；③ 预置不存在 PID 999999 → 判 stale 偷锁，备份成功；④ 预置 PID 1（root launchd）→ **exit 0 而非拒绝**（见 F-B1）。

### Low×3（health.ts，随 wave-1）— **成立**
`bank_id?: string` 死字段已删（`LlmProbeResponse` 仅剩 `operations`）；头注标题已改 Four-state（正文 "the honest fourth" 表述保留）；service_down 判定分支裸 `catch` 已改 `catch(error)` + `log.info`（`hindsight-health-service-probe-failed`：error 名 + message + timestamp），与 gateway 探针 catch 的日志契约逐字段对称；状态对象仍只报状态。

## 4. 亲自复跑验证（全部在本审阅执行）

| 项 | 命令 | 结果 | 期望 |
| --- | --- | --- | --- |
| 全套 12 文件 | `cd server && TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test' bun test …`（ticket-378 §2 清单） | **104 pass / 0 fail / 408 expect / 12 files** | 104/0 ✓ |
| hindsight 2 文件 | `bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` | **23 pass / 0 fail / 55 expect**（config 14 + health 9） | 23/0 ✓ |
| 类型检查 | `cd server && bunx tsc --noEmit` | exit 0 | ✓ |
| 语法 | `bash -n deploy/hindsight/backup.sh` | 通过 | ✓ |
| Lint（加分项） | `shellcheck -S warning deploy/hindsight/backup.sh` | 0 findings | ✓ |
| **真实容器复跑** | `deploy/hindsight/backup.sh` 对运行容器 `openbot-hindsight`（Up 16h, healthy） | **exit 0**，`retention 30d`（本工作区无 hindsight.env → 默认 30），产物 `hindsight-20261016T082337Z.sql.gz`：`-rw-------`（0600）、8,026 B gzip / 57,902 B 明文（与轮 1 记录 57,902 B 逐字节同源）、`gzip -t` 通过、`-- PostgreSQL database dump` 头 + `\unrestrict` 尾（真实 dump，非 OCI 错误文本）、`.part`/锁文件零残留 | ✓ |
| 锁行为探针 | §3 flock 条目所列 ①–④（backups/ 内预置锁文件，事后全部清理） | ①③④ 如述；② 拒绝路径 exit 1 | ✓（④ 见 F-B1） |

复跑后 `git status` 与审阅前完全一致；HEAD 仍 `f0520524`。

## 5. Findings（无 critical / high / medium）

| # | 级别 | 发现 | 建议 |
| --- | --- | --- | --- |
| F-B1 | **low** | 无 flock 回退路径的存活检测以 `kill -0 "$LOCK_HOLDER"` 成败判定，未区分 **EPERM**（进程存活但无权限发信号）与 ESRCH（不存在）：持锁 PID 属其他用户/root 时（实测 macOS 预置 PID 1），`kill -0` 失败 → 误判 stale → 偷锁继续运行（实测 exit 0），违背注释 "a lock whose holder PID is no longer alive is treated as stale" 的字面意图。**影响有界**：注释已披露 steal race 的最坏上界恰为"两个并发 run"（即本守卫原本要收窄的良性竞态）；常规同用户部署（cron/手动同一用户）不受影响；Linux 服务器有 flock 不走此路径；跨用户场景下 backups/ 目录 0700 亦使他人锁文件本就不可达 | 后续如收紧：以可区分 EPERM/ESRCH 的存活检测替代裸 `kill -0`（如 `ps -p`），或在注释中如实披露 EPERM 归入 stale 的折中 |
| F-B2 | info | backup.sh 的 wave-2 改动（M4/M5/flock，mtime 10:58）**尚未在 ticket-380.md 补记录**：现有 ocr2-fix 附录（10:33）声明 "deploy/hindsight/** 本轮零改动" 已过时，且 `b7270f9d…` 无处登记 | 由执行方补一段 wave-2 附录（改动描述 + 改后 sha256 + 验证证据），恢复检查点链完整性 |
| F-B3 | info | backup.sh 两条 `docker compose` 调用带 `-f "$HERE/docker-compose.yml"` 锚定，轮 1 字节不可得，无法确认是否 wave-2 新增；语义良性（消除 cwd/project 推断歧义，与 R8 harness 的 project 语义一致），无泄漏/回退风险 | wave-2 附录补记时一并声明归属即可 |

## 6. 总体判定

**PASS。** 当前工作区：19/23 文件与轮 1 基线逐字节一致，3 个 ts 文件 == ocr2-fix 附录改后值且以轮前副本真 diff 证明两轮累计变化与两轮附录声明逐 hunk 穷尽对齐、零夹带；唯一偏差 backup.sh 即任务预期的 wave-2 改动本体。五项 OCR medium（M1–M5）+ Low×3 + flock 独占回退全部以代码审读 + 本审阅独立实测（真 diff、104/0 与 23/0 复跑、tsc/bash -n/shellcheck、真实容器备份复跑、锁拒绝/偷锁/清理路径探针）证实真正解决。仅 1 条 low（EPERM 误判，上界已被注释披露且常规场景不可达）+ 2 条 info（文档滞后为主），无阻塞。

— 审阅完成于只读工作区，未改动任何被审文件（本报告与 git-ignored 运行态产物除外），未 commit/push。
