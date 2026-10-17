# OCR 轮 4 fix 批次独立复审（聚焦 · 只读）

- **审阅人**：OCR 轮 4 fix 复审 Agent（Orca 分派，task_80c27c0424f0 / ctx_4568550b48c7）
- **审阅对象**：`/Users/wuyongjun/trea/OpenBot-hindsight-exec`，HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` + 全部未提交改动
- **基线**：`reports/ocr3-fix-review.md`（OCR 轮 3 复审）+ `reports/ticket-380.md` 末尾《附录：wave-2》与《附录：ocr4-fix》（被审对象自述，task_448975ce2ad6，2026-10-16 22:1x–22:3x CST）；"reports/" 指 `docs/plans/2026-10-15-hindsight-personal-memory/reports/`
- **纪律**：只读。未 commit/push，未修改任何被审文件（本报告除外）；未触碰真实容器配置（`openbot-hindsight` 全程 `Up (healthy)`，9999 保持不发布，`/version` 复核 `llm_trace:false`）；未运行 `iostat -c`。medium-A 演练在 `/tmp/ocr4-rev-drill*/`（已清理），四场景 standin 用后已 pkill 并确认 9100 监听归零，本审阅 /tmp 探针产物已清理。

## 结论速览

| 维度 | 判定 |
| --- | --- |
| 检查点完整性（23 个交付文件 sha256 全表） | **PASS**（21 个未改动文件 == 轮 3 复审基线逐字节，含 4 个 ocr3 改动文件；2 个本轮改动文件 == ocr4-fix 附录"改后"值；**零偏差**） |
| 变化集 == 预期（backup.sh + verify-health.ts + ticket-380.md） | **PASS**（backup.sh 以 wave-2 副本 `b7270f9d` 做 diff：恰 3 hunk = sweep 块整体搬迁 + 头注指针更新 + 新增取舍注释，sweep 注释块**逐字节一致**；verify-health.ts 以轮 1 基线副本 `dff17709` 做 diff：恰 2 hunk = 头注 + try/catch，成功路径契约不变；ticket-380.md 两节附录落在文件末尾，ocr3 内容抽查与轮 3 复审记录逐字一致。**零夹带**） |
| medium-A（backup.sh sweep 前置于 dump 链） | **已解决**（/tmp 失败演练亲测：PATH 前置 `exit 1` docker stub → 脚本 exit 1、stderr 仅 stub 一行、**31 天副本已删、29 天副本保留、零 .part/锁文件残留**；同法对照旧版 wave-2 脚本 → 31 天副本幸存，证明修复针对的真实缺陷；执行者 /tmp/ocr4-drill 残留产物与其附录声明逐项吻合） |
| medium-B（verify-health.ts 崩溃路径治理） | **已解决**（清空 HINDSIGHT_* 后亲测：`happy: HINDSIGHT_API_URL is required and is not configured.` 单行 stderr、**exit 1、无堆栈**、stdout 无 JSON；四场景 happy/gateway-down/bad-config/service-down 对真实实例全部按契约单行 JSON + 预期状态 + exit 0） |
| 新问题引入 | **无 critical/high/medium**（2 info，见 §6，均为 /tmp 探针残留与文档口径备注，非代码缺陷） |
| 测试/类型（全部亲自复跑） | **PASS**（**规范 ticket-378 §2 清单 12 文件 104 pass / 0 fail / 408 expect**，含 bot-lifecycle.integration.test.ts；hindsight 2 文件 **26/0/61**；`bunx tsc --noEmit` exit 0；`bash -n backup.sh` 通过） |
| **总体判定** | **PASS** |

---

## 1. 检查点完整性（sha256 全表重算）

对全部 23 个交付文件逐一重算 sha256（基线 = ocr3-fix-review §1 + ocr4-fix 附录"改后"值）：

**21 个未改动文件 == 轮 3 复审基线逐字节一致**：

| 文件 | 实测 sha256 | 基线归属 |
| --- | --- | --- |
| `server/src/index.ts` | `21f9fd8c007796904456303c99fb76297910b3b4890e8a4dd674c4060884a116` | ocr3-fix 改后值（本轮未动） |
| `server/src/hindsight/health.ts` | `ffa9d47758bec4861951f8079c74e49e8a6a80c7fa9cfaa9e22cdff08ed5a563` | 同上 |
| `server/src/hindsight/config.ts` | `6ce1b396a0e0476778b8fae76b09a73bf2628e86ea5ff97b793554ee1f69931c` | 同上 |
| `server/tests/hindsight-health.test.ts` | `1d85e90438beaf7c3d06aad95535a103f5ff00783c268a834e476bfce75199e8` | 同上 |
| `server/tests/hindsight-config.test.ts` | `783c9542b378ebd767caa7ca94da48c85f5ced36bacae07d7d80437f97ad87eb` | ocr2-fix 改后值 |
| `server/src/memory/sensitivity.ts` | `18dc2d9a1b84a709e70a0b6a4f6429aa5793d226bbafa8586408d4a87e77bd67` | 轮 1 基线（ticket-378 ocr-fix 表） |
| `server/src/memory/store.ts` | `c35f6f04b1c8e6768cda9e3f946c8a55c943c7831d3a3c3ea408b08cd713b44d` | 同上 |
| `server/src/memory/ingestion.ts` | `0d13d16a0cb65603a97f7791095ecf62f2a55da2052bb67a86da6f104eaf9687` | 同上 |
| `server/src/memory/tools.ts` | `93fa491b1ceb4e594ff717b8f56c8fd2629f162df58acfce83f6bf8c748ac93f` | 同上 |
| `server/tests/memory-store.integration.test.ts` | `9a369e8ea79d107b71491264830148bba38a58ea6e97fa3daf1358922a39403e` | 同上 |
| `server/tests/memory-runtime.test.ts` | `eb4b78f474af174577ce2e289258697d8d840d0e0c741cad62dc520c864b9abc` | 同上 |
| `server/tests/memory-defaults.integration.test.ts` | `dd2d21c4a6691d6ed1a924c3b8578ec92042876e9e5ed506f1a932903363f765` | 同上 |
| `server/tests/proactive-store.integration.test.ts` | `4d17689b54048ea9f43d35533990f9c5ffaecd44ee27eb1f04339bf568816fdc` | 同上 |
| `server/tests/memory-sensitivity.test.ts` | `0701544d6e4b148000fad18ce5a577f5cb876d759780c46e8572eaacd7529a31` | 同上 |
| `server/tests/memory-expiry.test.ts` | `f1fc63c9fb2a14d86837295defe99495a7ef615f2a680bb231cd289329c6ae98` | 同上 |
| `server/tests/memory-intelligence.integration.test.ts` | `fdcce78399ebf5ef808c8ccbccb240862f74122f49cf545c30bdd00911be12d0` | 同上 |
| `deploy/hindsight/docker-compose.yml` | `656efbb0869ffebf664fe6d5c68f8362ff5dc214b67cbb8c9dd8723d2285108a` | 同上 |
| `deploy/hindsight/README.md` | `e4e8ac871071d5bc3c18fec0a6d46183aadf83e034d701ce7f86a5e57321fb8f` | 同上 |
| `deploy/hindsight/hindsight.env.example` | `d109e9f7cb1b8e692bff050f0f534ff2622d5ed58f0431ffc99f1bbc80597735` | 同上 |
| `deploy/hindsight/.gitignore` | `ad5f630d7c06efea8149b5c965b4b446417a3f71c8b85b320fcad925d2f5c572` | 同上 |
| `deploy/hindsight/test/gateway-standin.mjs` | `9fd4baed307fae0ce10d56f104781c0909a4935839e6ba2019c1ba1537c413cd` | 同上 |

**2 个本轮改动文件 == ocr4-fix 附录"改后"值**：

| 文件 | 实测 sha256 | 附录改后值 |
| --- | --- | --- |
| `deploy/hindsight/backup.sh` | `19beb92f960d09ac3ef0f02e579e02a1bd05443d7467f8e0b61c202220f95abb` | 一致 |
| `deploy/hindsight/test/verify-health.ts` | `590ffddf075b1f47549c709e2bca1c383e395e9bba8a01d7fb19a6789dcefa5b` | 一致 |

**隔离卫生**：HEAD 仍 `f0520524`；复审前后 `git status --porcelain` 快照逐字节一致（10 tracked M + 11 untracked 路径）；未 commit/push。本机主 worktree（`orca/workspaces/OpenBot/hs03-selfhost-service`）保有本轮改前副本：`backup.sh = b7270f9d…`（wave-2 值）、`verify-health.ts = dff17709…`（轮 1 基线），与基线记录互证。

## 2. 变化清单与"无夹带"证明

### 2a. backup.sh —— wave-2 副本真 diff（决定性证据）

`diff -u`（主 worktree `b7270f9d…` → 现工作区 `19beb92f…`）**恰 3 个 hunk**，全部与 ocr4-fix 附录声明一一对应：

1. **头注指针更新**（第 5–7 行区域）："see the sweep comment at the bottom" → "see the sweep comment below (it runs right after the lock, before the dump)"。其余头注文字不动。
2. **sweep 块搬迁 + 新增取舍注释**（锁获取代码块 `fi` 之后、`STAMP=` 之前）：新增 13 行 "Sweep placement: this runs BEFORE the dump chain, directly after the lock…"（涵盖：仅依赖宿主侧已校验的 `BACKUP_DIR`/`RETENTION_DAYS`、`set -euo pipefail` 下末尾 sweep 曾被任何 dump 步骤失败跳过、cron 仅写 backup.log、健康检查无备份证据、#391 对账、≤30 天为硬性隐私上限、dump 失败不得延长已过期副本存活、sweep 先于 dump 不可能误删本次新副本）；其后紧跟原 sweep 块。**sweep 注释块 + `find` 命令经提取比对与改前逐字节一致**（含 `+$((RETENTION_DAYS - 1))` 边界语义、`+0..+29` 域说明、2026-10-15 首测与 2026-10-16 rework 复测记录两段边界注释，无一字改动）。
3. **末尾删除**：原脚本末尾的 sweep 注释块 + `find … -delete` 移除，`echo "backup written: …"` 保留为最后一行。

位置核验：`find "$BACKUP_DIR" … -delete` 现位于第 176 行——锁代码块（~94–141 行，flock/noclobber 两路径）之后、`INSTANCE_JSON` 容器 manifest 读取（~196 行）与全部 `docker compose` 调用之前。零多余 hunk，**零夹带**。

### 2b. verify-health.ts —— 轮 1 基线副本真 diff

`diff -u`（`dff17709…` → `590ffddf…`）**恰 2 个 hunk**：

1. 文件头注补 4 行崩溃路径说明（"a one-line diagnostic goes to stderr and the runner exits 1 — the crash path must not print an uncaught stack trace"）。
2. 原四行顶层语句（`loadHindsightConfig` → `checkHindsightHealth` → `console.log(JSON.stringify(…))` → `process.exit(…)`）整体包入 `try`，另加 5 行注释与 `catch` 块：`console.error("<scenario>: <error.message 首行>")` + `process.exit(1)`，不打印堆栈。

成功路径三行语句逐字未动——"每场景一行 JSON（`{scenario, expected, ...status}`）+ 按状态匹配退出码"契约不变。零多余 hunk，**零夹带**。

### 2c. ticket-380.md —— 只追加两节附录

本文件 untracked、无历史副本可逐字节 diff，采用三重抽查佐证：① 《附录：wave-2》与《附录：ocr4-fix》两节依次位于文件末尾（第 310–365 行），其后无其他内容；② 头部引用块（fix1/ocr-fix/ocr2-fix/ocr3-fix 四行）与 §1 交付表、各历史附录均与历轮复审记录吻合，未发现对既有段落的改写痕迹；③ ocr3-fix 附录的 sha256 表（改前 `ceb5e581/e619eebf/59c72eac/f6fc21d6` → 改后 `21f9fd8c/ffa9d477/6ce1b396/1d85e904`）与 ocr3-fix-review §1 逐值一致，其验证证据段（"101 pass / 0 fail（385 expect）"及逐文件用例数）与轮 3 复审 F-C1 记述逐字一致。与任务简报"只追加两节附录"口径相符。

**预期外改动：0。**

## 3. medium×2 逐项解决判定

### medium-A（sweep 前置于 dump 链）— **已解决**

见 §2a（结构证明）+ §4 失败演练（行为证明）。dump 链失败时过期副本删除不再被阻断，边界语义逐字保留。

### medium-B（verify-health.ts 崩溃路径治理）— **已解决**

见 §2b（结构证明）+ §4 实测（env 清空 → 单行诊断 + exit 1 无堆栈；四场景成功路径契约不变）。

## 4. 亲自复跑验证（全部在本审阅执行）

| 项 | 命令/方法 | 结果 | 期望 |
| --- | --- | --- | --- |
| 语法检查 | `bash -n deploy/hindsight/backup.sh` | 通过 | ✓ |
| **medium-A 失败演练**（/tmp/ocr4-rev-drill，未触仓库；无 hindsight.env → 默认 30d；`touch -t` 造 31 天龄（-31d 12:00）与 29 天龄（-29d 12:00）副本；PATH 前置 `exit 1` 的 docker stub） | `PATH="$D/stub:$PATH" bash "$D/backup.sh"` | **exit 1**；stderr 仅一行 `stub: simulated docker/compose failure`；**31 天副本已删除、29 天副本保留**；backups/ 内零 `.part`/锁文件/新产物 | ✓ |
| medium-A 对照组 | 同法跑 wave-2 旧版脚本（`b7270f9d`） | exit 1（dump 链失败），**31 天副本幸存**——复现修复前的缺陷 | ✓（证明修复的必要性） |
| 执行者演练残留核验（只读） | 检查 `/tmp/ocr4-drill/` | 其 `backup.sh` == `19beb92f…`（即审后脚本本体）；backups/ 仅剩 29 天副本（31 天副本已删）；`run-stderr.log` 仅一行 stub 报错；`run-stdout.log` 空；零 .part/锁残留——与附录声明逐项吻合 | ✓ |
| **medium-B 崩溃路径** | `env -u`（全部 HINDSIGHT_*）后 `bun deploy/hindsight/test/verify-health.ts happy` | stderr 恰一行 `happy: HINDSIGHT_API_URL is required and is not configured.`；**exit 1**；无堆栈（grep "at " 无命中）；stdout 空 | ✓ |
| 四场景（真实实例 openbot-hindsight 8888 healthy，key localtest-hindsight-key；standin 9100 亲起亲杀，`--log /tmp/hindsight-gateway-standin-ocr4rev.log`） | `happy`（standin up） | `{"scenario":"happy","expected":"service_up","state":"service_up","checkedAt":"…T14:41:28.337Z","version":"1.0.0"}`，exit 0 | ✓ |
| 同上 | `gateway-down`（pkill standin 后，实测 9100 监听归零） | `{…"state":"gateway_down",…,"version":"1.0.0"}`，exit 0 | ✓ |
| 同上 | `bad-config`（`HINDSIGHT_PRIVACY_LLM_TRACE_ENABLED=true`） | `{…"state":"config_noncompliant","violations":["llm_trace_enabled"]}`，exit 0 | ✓ |
| 同上 | `service-down`（`HINDSIGHT_API_URL=http://127.0.0.1:59999`） | `{…"state":"service_down",…}`，exit 0 | ✓ |
| 四场景后清理 | `pgrep`/`lsof` | standin 进程 0、9100 监听 0；真实容器复核 `healthy`、`/version llm_trace:false`、started 时间未变 | ✓ |
| **规范 12 文件套件**（**逐字 ticket-378 §2 清单**，含 bot-lifecycle.integration.test.ts） | `cd server && TEST_DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test' bun test <§2 清单>`（容器 `openbot-hs01-378-pg` Up 22h） | **104 pass / 0 fail / 408 expect / 12 files** | 104/0/408 ✓ |
| hindsight 2 文件 | `bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` | **26 pass / 0 fail / 61 expect** | 26/0/61 ✓ |
| 类型检查 | `cd server && bunx tsc --noEmit` | exit 0 | ✓ |

## 5. 附录文档口径核对（前轮 findings 闭合判定）

- **F-C1（附录"全套"清单偏差，low）— 已闭合**：ocr4-fix 附录的"规范 12 文件套件"命令经逐词提取比对，与 ticket-378 §2 清单**逐字一致**（12 文件、含 `bot-lifecycle.integration.test.ts`、未替换任何文件），并以 `bot-lifecycle` 在列实证。本轮复跑 104/0/408 与之一致。
- **F-C2（wave-2 补记缺失，info）— 已闭合**：《附录：wave-2》已补记 rework 本体（`538d0fc4…` → `b7270f9d…`，M4/M5/flock/`-f` 锚定四项改动描述），其 `b7270f9d` 值与轮 2 复审独立实测及本机主 worktree 现存副本一致；附录并显式注明"本轮 ocr4-fix 另有其后的一次改动（见下附录），不与本节混淆"——backup.sh 检查点链 `538d0fc4 → b7270f9d → 19beb92f` 三环全部登记，缺口闭合。
- **轮 4 的 11 条 low 不修**（附录声明）：本轮 diff 未发现任何超出两文件一报告的改动，与"明确不修"的声明自洽。

## 6. Findings（无 critical / high / medium）

| # | 级别 | 发现 | 建议 |
| --- | --- | --- | --- |
| F-D1 | info | 执行者探针产物留存 `/tmp`：`/tmp/ocr4-drill/`（含审后 backup.sh 副本与演练残档）与 `/tmp/hindsight-standin-ocr4.stdout` 未清理。附录未声明 /tmp 清理（仅声明 git status/容器卫生，均属实），产物本身无敏感内容（stub 无口令、dump 副本为 0 字节空文件），但与轮 3 复审"探针产物全清"的惯例口径不一致 | 后续轮次统一清理 /tmp 探针产物，或在附录末尾注明留存位置 |
| F-D2 | info | 头部引用块（第 26–32 行）止于 ocr3-fix，未为 ocr4-fix 追加指针行；读者从文首无法预知文末新增两节。与任务简报"只追加两节附录"的口径一致，故不算偏差，仅为文档导航便利性观察 | 后续大版本 checkpoint 可在头部补一行总索引（属 ticket 维护者裁量） |

## 7. 总体判定

**PASS。** 两项 medium 修复（backup.sh sweep 前置于 dump 链、verify-health.ts 崩溃路径治理）以改前副本真 diff 的逐 hunk 归属 + 本审阅独立失败演练/四场景实测（含对照组复现旧缺陷）证实真正解决且无行为回归；变化集与 ocr4-fix 附录声明穷尽对齐，23 文件 sha256 全表零偏差，零夹带；F-C1/F-C2 文档缺口闭合（附录清单逐字对齐 §2 规范清单、wave-2 检查点链闭合）；规范 12 文件套件 104/0/408、hindsight 26/0/61、tsc 0、bash -n 通过；工作区隔离卫生（HEAD 不变、git status 不变、真实容器零触碰、9100 归零）。仅 2 条 info（/tmp 探针残留、文档导航观察），无阻塞。

— 审阅完成于只读工作区，未改动任何被审文件（本报告除外），未 commit/push。
