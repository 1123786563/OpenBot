# OCR 轮 8 fix 批次独立复审（聚焦 · 只读）

- **审阅人**：OCR 轮 8 fix 复审 Agent（Orca 分派，task_9b35d0426eb5 / ctx_7f8001182012）
- **审阅对象**：`/Users/wuyongjun/trea/OpenBot-hindsight-exec`，HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` + 全部未提交改动
- **基线**：`reports/ocr7-fix-review.md`（OCR 轮 7 复审，23 文件 sha256 全表，其中 sensitivity.ts `ff854ea0…` / memory-sensitivity.test.ts `b3f96b63…` / backup.sh `c6993e6b…`）+ `reports/ticket-378.md` 末尾《附录 ocr8-fix》（sensitivity 侧，task_41ca275b05dc）与 `reports/ticket-380.md` 末尾《附录：ocr8-fix》（deploy 侧，task_41ca275b05dc）；"reports/" 指 `docs/plans/2026-10-15-hindsight-personal-memory/reports/`
- **纪律**：只读。未 commit/push，未修改任何被审文件（本报告除外）；未触碰真实容器配置（`openbot-hindsight` 审阅前后均 `Up 26 hours (healthy)`、8888 仅绑 127.0.0.1、9999 不发布、`StartedAt = 2026-10-15T16:07:15.207817738Z` 审阅前后一致；`openbot-hs01-378-pg` 同窗口 `Up 26 hours` @5573）；未运行 `iostat -c`。backup.sh 行为演练用副本置于 `/tmp/ocr8rev-drill/`（本审阅独立命名，含 docker stub 两个变体：静默 exit 1 与"睡 1.2s 再 exit 1"观测窗变体），全部用后已删除并复核 **0 残留**。

## 结论速览

| 维度 | 判定 |
| --- | --- |
| 检查点完整性（23 个交付文件 sha256 全表） | **PASS**（20 个未改动文件 == ocr7-fix-review 基线逐字节，含 verify-health.ts `5a94cfdf…` 原值保持；3 个本轮改动文件 == 两份 ocr8-fix 附录"改后"值：sensitivity.ts `69856327…`、memory-sensitivity.test.ts `14ff9335…`、backup.sh `ab12dc1a…`。**零偏差**） |
| 两份报告只追加声明 | **成立**（ticket-378 `head -417` raw == 附录记载改前 `5e227e87…`；ticket-380 `head -500` raw == `cbf210a3…`；ocr7 旧链同法复现——ticket-378 `head -382` 剥 1 末尾换行 == `917049e0…`、ticket-380 `head -463` 剥 1 换行 == `68f7d1b1…`、ocr6 链 `head -410` 剥 1 换行 == `6a2a4e13…`。双向复现，见 §1c） |
| 变化集 == 预期（3 代码文件 + 2 报告追加） | **PASS**（sensitivity.ts 三类新形状恰插在 `api_?key\|secret\|password` 名值对之后、停用词负向断言在列；测试文件 8 正 + 8 反与附录清单逐条一致；backup.sh `kill -0 \|\| ps -p` 复核 + EPERM/ESRCH 注释 + 头注/锁总注释同步 + :70 三层文案含 #391；git status 快照 10 tracked M + 11 untracked = 21 行与前轮记录一致；审阅窗口 mtime 扫描 0 命中——全部交付文件 mtime ≤ 01:53:19，早于审阅起点。**零夹带**） |
| medium-G（sensitivity 三类新形状，任务判定 G） | **已解决**（静态：恢复短语/助记词词表形态 pattern、2FA/MFA 备份码数字串、OTP/验证码 4-8 位三类在列且注释完整；独立 `bun -e` 直调分类器 **25/25 过**——16 条新正反例 + 任务指定反例 "the recovery phrase is explained in the docs" + 停用词护栏抽查 5 变体（for the wallet 语法词串 / one two three 数词 / the sun and the moon / listed below 列举散文词 / device rhymes 负向断言词）+ 9 字母词越界反例 + 5 词真值仍命中 + 既有形状回归 `token of appreciation`/`our pwd is wrong`） |
| medium-H（stale 判定 ps -p 复核，任务判定 H） | **已解决（/tmp 演练实证；本机无 flock，回退即真实路径）**（死 PID 锁被偷：睡眠观测窗内锁文件已换为脚本自身存活 PID（`kill -0` 与 `ps -p` 双可见）、旧死锁被 rm、sweep 照跑（60d 龄超龄备份被删）、抵达 dump 链（marker）、exit 1（stub）、stderr 0 字节、EXIT trap 清锁零残留零 .part；存活 PID 锁：exit 1、stderr 恰一行 `refusing to run: another backup (pid …) is holding …`、锁文件内容原样未动、未抵达 dump 链、拒绝路径不跑 sweep；EPERM 分支本机无法伪造他用户进程——按任务许可与附录同口径以静态逻辑核对（`kill -0` 失败 → `ps -p … -o pid=` 复核：可见即拒绝、不可见才偷锁）+ `ps -p` 语法双向实测（存活退出 0 且打印 pid、死亡退出非 0）闭合并如实记录） |
| medium-I（缺声明文案如实化 vs config.ts，任务判定 I） | **已解决（静态核对）**（config.ts `loadHindsightConfig(env = process.env)` 仅读进程 env；server/src/hindsight 无任何 hindsight.env 解析（唯 config.ts:7 注释提及且说的是 Hindsight 服务自身）；`validateHindsightPrivacy` 对 null / `< MIN_BACKUP_RETENTION_DAYS(1)` / `> MAX_BACKUP_RETENTION_DAYS(30)` 报 `backup_retention_days`——backup.sh :70 三层文案（进程 env / 脚本旁 hindsight.env + OpenBot 部署环境 only + 仅 hindsight.env 声明仍报 noncompliant + #391）与 config.ts 实际读取范围逐句一致；缺声明 /tmp 演练行为复现：exit 1、stdout 0 字节、stderr 恰一行新文案） |
| 测试/类型/语法/Lint（全部亲自复跑） | **PASS**（规范 12 文件套件（ticket-378 §2 :42 逐字清单）**104 pass / 0 fail / 436 expect / 12 files**（基线 420 + 16 新断言）；hindsight 两文件 **27/0/62**；memory-sensitivity 单文件 **7/0/100**（84 → 100，+16）；`bunx tsc --noEmit` exit 0；`bash -n backup.sh` 通过；`bunx biome check`（sensitivity.ts / memory-sensitivity.test.ts）0 问题） |
| 附录哈希表 / F-C1 口径 / Wave 2 八条 low | **一致 / 闭合 / 如实**（3 个"改后"值 + verify-health.ts 保持值逐一相符；执行清单即从 ticket-378.md :42 `sed` 提取的原串（`$(cat …)` 直接展开，构造上逐字）；Wave 2 server 4 条（health.ts:124 静默 catch、:202 空 operations → gateway_down、ingestion.ts:279 双份判定、store.ts:548 嵌套三元）与 deploy 4 条（backup.sh 仅 EXIT trap、standin :147-156 路由双份 + req.url 未剥 query、:162 listen 无 error 处理器、:56 /tmp 可预测日志 + appendFileSync）逐条对码实质成立且原样未修。1 条行号转写漂移见 F-I1） |
| 新问题引入 | **无 critical / high / medium**（1 info（Wave 2 行号转写漂移）+ 2 备注（派单"67 行"实为相邻注释块行号、文案本体在 :70；单文件跑测试同样需要 TEST_DATABASE_URL）。见 §5） |
| **总体判定** | **PASS** |

---

## 1. 检查点完整性（sha256 全表重算）

对全部 23 个交付文件逐一重算 sha256（基线 = ocr7-fix-review §1 全表）：

### 1a. 20 个未改动文件 == ocr7-fix-review 基线逐字节一致

| 文件 | 实测 sha256 |
| --- | --- |
| `server/src/index.ts` | `21f9fd8c007796904456303c99fb76297910b3b4890e8a4dd674c4060884a116` |
| `server/src/hindsight/config.ts` | `6ce1b396a0e0476778b8fae76b09a73bf2628e86ea5ff97b793554ee1f69931c` |
| `server/tests/hindsight-config.test.ts` | `783c9542b378ebd767caa7ca94da48c85f5ced36bacae07d7d80437f97ad87eb` |
| `server/src/memory/store.ts` | `c35f6f04b1c8e6768cda9e3f946c8a55c943c7831d3a3c3ea408b08cd713b44d` |
| `server/src/memory/ingestion.ts` | `0d13d16a0cb65603a97f7791095ecf62f2a55da2052bb67a86da6f104eaf9687` |
| `server/src/memory/tools.ts` | `93fa491b1ceb4e594ff717b8f56c8fd2629f162df58acfce83f6bf8c748ac93f` |
| `server/tests/memory-store.integration.test.ts` | `9a369e8ea79d107b71491264830148bba38a58ea6e97fa3daf1358922a39403e` |
| `server/tests/memory-runtime.test.ts` | `eb4b78f474af174577ce2e289258697d8d840d0e0c741cad62dc520c864b9abc` |
| `server/tests/memory-defaults.integration.test.ts` | `dd2d21c4a6691d6ed1a924c3b8578ec92042876e9e5ed506f1a932903363f765` |
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

（其中 verify-health.ts 是 ocr7 轮改动文件，本轮**零改动**、保持 ocr7 终值——符合派单预期。）

### 1b. 3 个本轮改动文件 == ocr8-fix 附录"改后"值

| 文件 | 实测 sha256 | 附录改后值 | 附录改前值（== ocr7 基线） |
| --- | --- | --- | --- |
| `deploy/hindsight/backup.sh` | `ab12dc1ae301edfd2c8bd1c7a9c438f956c6b745c3b4921be5deb6d455bc165e` | 一致 | `c6993e6b…` ✓ |
| `server/src/memory/sensitivity.ts` | `69856327ec7dc65e36b1222aa9362ffa8c9df8e1ef99d65243229a133b60da8d` | 一致 | `ff854ea0…` ✓ |
| `server/tests/memory-sensitivity.test.ts` | `14ff9335c29c341aca4e8d3b338eecab8ef8a00a2beb9ce7fb2c7c4bfd72cda3` | 一致 | `b3f96b63…` ✓ |

### 1c. 两份报告只追加哈希链复核

- **ticket-378.md**（454 行）：ocr8 附录起点第 419 行，`head -417`（raw，含末尾换行）sha256 == 附录记载改前值 `5e227e87d41be72dde70d75c441066d75f1933f0ba24f8bc265d3a45cb02dd1b` ✓；ocr7 链同法复现（`head -382` 剥恰 1 个末尾换行字节 == `917049e0…` ✓）。
- **ticket-380.md**（539 行）：ocr8 附录起点第 502 行，`head -500`（raw）== 附录记载改前值 `cbf210a330d3f88d08fe282d0749ef12399dfcc1e402c931430f74060752ae5a` ✓；ocr7 链（`head -463` 剥 1 换行 == `68f7d1b1…` ✓）与 ocr6 链（`head -410` 剥 1 换行 == `6a2a4e13…` ✓）均复现。

**剥离惯例说明**：旧链记录值为"剥恰 1 个末尾换行字节"（`head -c $((bytes-1))`）；本轮两条"改前"值恰为 raw `head` 直算。两种口径均唯一复现，逐字节追加以实测匹配为准。

**隔离卫生**：HEAD 仍 `f0520524`；`git status --porcelain` 为 10 tracked M + 11 untracked 路径（21 行），与前轮记录快照一致；未 commit/push；审阅窗口 mtime 扫描 0 命中（全部交付文件 mtime ≤ `2026-10-17 01:53:19`，早于审阅起点）。

## 2. 变化清单与"无夹带"证明

三个改动文件的精确改前副本均无留存，采用"静态通读对声明 + 行为实测 + 20 文件零偏差包围"证法：

- **backup.sh**（相对 ocr7 基线值 `c6993e6b…` 声明的本轮 delta）：① 无 flock 回退 holder 分支：`kill -0 "$LOCK_HOLDER"` 失败不再直接判 stale，改为 `kill -0 … || ps -p "$LOCK_HOLDER" -o pid= >/dev/null 2>&1` 复核——ps 可见（EPERM 情形）走拒绝分支照常 exit 1、ps 也不可见（ESRCH）才 `rm -f` 偷锁重建；分支处新增 6 行注释写明 EPERM/ESRCH 语义、共享 BACKUP_DIR（cron 用户 A / 操作员用户 B）误判后果与 ps 复核理由（:151-156）；上方锁总注释同步补"aliveness by `kill -0` re-checked with `ps -p` …"一句（:109-111）。② :70 缺声明拒绝文案如实化（三层：进程 env / 脚本旁 hindsight.env、OpenBot 侧只读部署环境、仅 hindsight.env 声明仍报 noncompliant）+ `#391` 指向；三处相关注释同步：头注"两组件声明层不同"段（:8-14）、No implicit default 块（:63-68）、validation 块（:71-75）。域校验/引号 CR 剥离/10# 重基/双模锁/dump 链/两条 `-maxdepth 1` find/shape-check 均不在本轮声明 delta 内。
- **sensitivity.ts**：在 `/\b(?:api_?key|secret|password)s?\b[=:]\s*…/` 名值对模式之后插入三类新 pattern：① 恢复短语/助记词词表形态（名称 `\b(?:(?:recovery|seed) ?(?:phrases?|words?)|mnemonics?)\b` + `[=:]`/`is`/直接空格 + 3+ 个连续 3-8 纯字母词，每词前置大停用词集负向断言——语法词/数词（one…twelve）/列举散文词（listed/below/written/explained/device/rhyme…）；注释写明"真实短语 12+ 词故 3 词下限藏不住真值"与"罕见 3 普通内容词散文宁误拒"的立场）；② 2FA/MFA 备份码（`\b(?:(?:two[- ]factor|2fa|mfa)\s+(?:backup\s+)?|backup\s+)codes?\b` + `\d{4,}|\d[\d -]{2,}\d` 分组值）；③ OTP/验证码（`\b(?:otp|verification|auth(?:entication)?)\s+codes?\b` 与裸 `\botp\b` 两模式 + `\d{4,8}\b`）。各配注释说明反例语义。
- **memory-sensitivity.test.ts**：新增恰一个 ocr8 用例块并入既有分类测试——正例 8（任务原例 "Please remember my wallet recovery seed phrase: apple banana cherry danger"、裸词表 `seed phrase apple banana cherry dog elephant fuel`、`the mnemonic is amber fossil ledger river`、`2FA backup codes 8722 0091 4455`、`my backup code is 87220091`、`the transfer OTP is 482913`、`verification code: 042917`、`auth code 4821 arrived by SMS`）+ 反例 8（任务指定 "the recovery phrase is explained in the docs"、"the mnemonic for the wallet is in the vault"、"seed words written on paper are gone"、"backup codes are required for the admin panel"、"our 2FA rollout covers every admin"、"the OTP screen times out after thirty seconds"、"verification codes expire after five minutes"、"the auth code field is case sensitive"），逐条与附录清单一致；既有用例原样保留（文件级哈希与附录改后值一致即证）。
- **夹带穷尽核查**：`git status` 快照 21 行与前轮一致；20 个未改动交付文件哈希零偏差（含 verify-health.ts 保持 ocr7 终值）；审阅窗口 mtime 扫描 0 命中。**预期外交付物改动：0**。

## 3. 三条 medium 有效性判定（任务指定 G / H / I）

### medium-G：sensitivity 三类新形状（sensitivity.ts + 测试）— **已解决**

- 静态：§2 所列三类模式与注释逐条在位，插入位置与附录口径一致（`api_?key|secret|password` 名值对之后）；恢复短语模式的词表形态由 `(?!停用词)[a-z]{3,8}` ×3 实现（前两词后必须跟空白），停用词负向断言覆盖语法词、数词 one…twelve 与列举散文词。
- 行为（独立 `bun -e` 直调 `classifyMemorySensitivity`，**25 用例 25/25 过**）：
  - 8 正例全部 `credential`：测试文件中的 8 条新正例逐条复现（含任务原例 recovery seed phrase + 4 词表词、分组备份码 `8722 0091 4455`、连写备份码 `87220091`、4/6 位 OTP 与验证码）。
  - 反例全部 `normal`：测试文件 8 条新反例逐条复现，含**任务指定反例 "the recovery phrase is explained in the docs"**（2 字母 `is` 与 9 字母 `explained` 双重破坏词表形态）。
  - **词表形态停用词护栏抽查 6 变体**（任务要求项）：`recovery phrase for the wallet is in the vault`（for/the/is 语法词串）、`seed phrase one two three`（数词）、`recovery phrase: the sun and the moon`（the/and）、`seed words listed below are important`（listed/below）、`mnemonic device rhymes help memory`（device/rhyme 负向断言词）全部保持 normal；`recovery phrase sunshine wonderful beautiful`（三个 9 字母词越 3-8 界）保持 normal；`mnemonic is amber fossil ledger river summit`（5 词真值）仍 `credential`。
  - 既有形状回归：`I keep a token of appreciation from my team` → `credential`（名称即拒不变）、`our pwd is wrong` → `normal`（不变）。
- 测试面：8 正 + 8 反与附录清单逐条一致；单文件 84 → 100 expect（+16 恰为本轮新断言）；12 文件套件 420 → 436（+16）精确吻合。

### medium-H：stale 判定 EPERM 误判（backup.sh）— **已解决（/tmp/ocr8rev-drill 演练实证；已清理）**

本机 stock macOS 无 `flock`，无 flock 回退即真实路径。演练副本 + `PATH` 前置 docker stub（静默 exit 1 变体与"睡 1.2s 再 exit 1"观测窗变体）+ 声明 env `HINDSIGHT_PRIVACY_BACKUP_RETENTION_DAYS=30`：

- **死 PID 锁 → 偷锁重建 + sweep 照跑**：锁文件写入预先 `kill -0` / `ps -p` 双重复核确死的 PID（96266）→ 运行后在 stub 睡眠观测窗内读锁文件，内容已换为脚本自身存活 PID（旧死锁被 `rm` 重建），`kill -0` 与 `ps -p` 对新 PID 双双可见 ✓；60d 龄伪造超龄备份 `hindsight-20260101000000.sql.gz` **已被 sweep 删除**（锁块后 dump 链前的 sweep 在偷锁路径照跑实证）；marker 文件存在（抵达 dump 链）；**exit 1**（stub 处）、stderr 0 字节、stdout 0 字节；EXIT trap 清锁，退出后零锁残留、零 `.part` 残留。
- **存活 PID 锁 → 拒绝运行（kill -0 成功路径）**：锁文件写入驱动 shell `$$`（98570，存活）→ **exit 1**、stdout 0 字节、stderr 恰一行 `refusing to run: another backup (pid 98570) is holding /tmp/ocr8rev-drill/backups/.backup.lock; overlapping runs are not started`；锁文件内容**原样未动**（读回比对一致）；marker 不存在（未抵达 dump 链）；预先放置的超龄文件仍在（拒绝路径不跑 sweep，符合"sweep 在锁块之后"的静态次序）。
- **EPERM 分支**：需要另一用户的存活进程，本机无法伪造——按任务许可与附录同口径以**静态逻辑核对**闭合：:157 `if kill -0 "$LOCK_HOLDER" 2>/dev/null || ps -p "$LOCK_HOLDER" -o pid= >/dev/null 2>&1; then 拒绝` ——`kill -0` 成功短路拒绝（存活本主进程）、失败时 ps 可见即 EPERM 存活照常拒绝、ps 也不可见（ESRCH）才落入 `rm -f` 偷锁；分支注释（:151-156）逐句与该语义一致。辅以 **ps 语法双向实测**：`ps -p <存活pid> -o pid=` 退出 0 且打印 pid；`ps -p <死pid> -o pid=` 退出非 0。无未验证断言遗留，如实记录。
- **缺声明演练**（medium-I 行为面）：`env -i` 清空环境、演练目录无 hindsight.env → **exit 1**、stdout 0 字节、stderr 恰一行 :70 新三层文案（进程 env / 脚本旁 hindsight.env + OpenBot 部署环境 only + 仅 hindsight.env 声明仍报 `backup_retention_days` noncompliant + #391），与源码字面一致。

### medium-I：缺声明文案如实化 vs config.ts 实际读取范围 — **已解决（静态核对）**

- `server/src/hindsight/config.ts`：`loadHindsightConfig(env: Record<string, string | undefined> = process.env)` 默认仅读进程 env，函数体无任何文件解析；`parseHindsightPrivacy` 仅读三个 `HINDSIGHT_PRIVACY_*` 键；`validateHindsightPrivacy` 在 `backupRetentionDays === null || < MIN_BACKUP_RETENTION_DAYS(1) || > MAX_BACKUP_RETENTION_DAYS(30)` 时 push `"backup_retention_days"`。`grep -rn hindsight.env server/src/` 唯一命中为 config.ts:7 **注释**（且说的是 Hindsight 服务自身从 hindsight.env 读配置，非 OpenBot 侧校验）；`grep readFileSync|readFile server/src/hindsight/` 零命中（server/src 其余 readFile 命中均在 workshop/craft/computer 等无关模块）。
- backup.sh :70 文案三层表述与上述现实**逐句一致**："in the process environment or in the hindsight.env next to this script"（脚本侧两层）→ "OpenBot's privacy health check (server/src/hindsight/config.ts) reads HINDSIGHT_PRIVACY_* from the OpenBot deployment environment only, never from hindsight.env"（OpenBot 侧仅部署环境）→ "a declaration only in hindsight.env runs this script yet still reports backup_retention_days noncompliant"（config.ts 对 null 键即报该 violation，行为面由缺声明演练复现）→ "#391"。1..30 域字面与 `MIN_BACKUP_RETENTION_DAYS = 1` / `MAX_BACKUP_RETENTION_DAYS = 30` 一致。
- 三处注释同步如实化：头注 :8-14（"The declaration layers of the two components are NOT the same … declare the same number in both layers"）、No implicit default 块 :63-68（"the health check — reading the OpenBot deployment environment, not hindsight.env — reports config_noncompliant"）、validation 块 :71-75（"declare 1..30 in this script's layers … AND in the OpenBot deployment environment its health check reads (#391)"）。

## 4. 亲自复跑验证（全部在本审阅执行）

| 项 | 命令/方法 | 结果 | 期望 |
| --- | --- | --- | --- |
| 规范 12 文件套件 | `cd server && TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5573/openbot_hs01_378_test bun test $(ticket-378.md :42 sed 提取原串)`（容器 `openbot-hs01-378-pg` Up 26h @5573） | **104 pass / 0 fail / 436 expect / 12 files**（2.49s 一次通过） | 104/0/436 ✓ |
| hindsight 2 文件 | `bun test ./tests/hindsight-config.test.ts ./tests/hindsight-health.test.ts` | **27 pass / 0 fail / 62 expect** | 27/0/62 ✓ |
| sensitivity 单文件 | `TEST_DATABASE_URL=… bun test ./tests/memory-sensitivity.test.ts` | **7 pass / 0 fail / 100 expect**（84 → 100，+16） | 7/0/100 ✓ |
| 类型检查 | `cd server && bunx tsc --noEmit` | exit 0 | ✓ |
| 语法检查 | `bash -n deploy/hindsight/backup.sh` | 通过 | ✓ |
| Lint | `bunx biome check server/src/memory/sensitivity.ts server/tests/memory-sensitivity.test.ts` | 0 问题（"No fixes applied"） | ✓ |
| 分类器抽查 | `bun -e` 直调 `classifyMemorySensitivity`（16 新正反例 + 任务指定反例 + 6 护栏变体 + 1 真值 + 2 回归） | **25/25 符合预期** | ✓ |
| stale 判定演练 | /tmp/ocr8rev-drill 副本 + docker stub 两变体（§3-H） | 死 PID 偷锁 + sweep 照跑 + 活 PID 拒绝 + 锁不破坏，全断言过 | ✓ |
| ps 语法双向实测 | `ps -p <存活> -o pid=` / `ps -p <死> -o pid=` | 退出 0 且打印 pid / 退出非 0 | ✓ |
| 缺声明演练 | `env -i` + 无 hindsight.env 副本 | exit 1、stdout 0B、stderr 恰一行三层文案含 #391 | ✓ |
| 附录哈希表 | 3 个"改后"值 + verify-health.ts 保持值 vs 实测 | 逐一一致 | ✓ |
| 两报告只追加链 | `head -417`/`head -500` raw + ocr7/ocr6 旧链剥 1 换行复算 | `5e227e87…` ✓ / `cbf210a3…` ✓（旧链 `917049e0…`/`68f7d1b1…`/`6a2a4e13…` ✓） | ✓ |
| F-C1 口径 | `sed -n '42p' ticket-378.md` 提取 `bun test` 后清单（12 文件）→ `$(cat …)` 直接作为执行参数 | 构造上逐字一致（未替换、未增删任何文件） | ✓ |
| Wave 2 对码 | server 4 条 + deploy 4 条逐条对文件 | 实质全部成立且原样未修（涉事 4 文件中 health.ts/standin.mjs/ingestion.ts/store.ts 哈希均未变；backup.sh 本轮改动与该 low 无交集——trap 仍仅 EXIT 一处）。1 条行号转写漂移见 F-I1 | ✓ |
| 探针清理 | `rm -rf /tmp/ocr8rev-drill`（含 fc1 清单临时文件）；复核 | 0 残留 | ✓ |
| 真实容器复核（审阅前后各一次） | `docker ps` + `docker inspect` | 全程 `Up 26 hours (healthy)`、8888 仅 127.0.0.1、9999 不发布、StartedAt `2026-10-15T16:07:15.207817738Z` 未变 | ✓ |

## 5. Findings（无 critical / high / medium）

| # | 级别 | 发现 | 建议 |
| --- | --- | --- | --- |
| F-I1 | info | ticket-380 附录 Wave 2 第 1 条记 `deploy/hindsight/backup.sh:224`（清理逻辑只挂 EXIT trap），该行号对应**改前文件**（c6993e6b…）中的 trap 位置；本轮在其上方插入 ps -p 复核与两处注释（合计约 12 行）后，trap 语句现位于 **:236**。与 ocr7 F-H1 同类：OCR 工具对改前快照给出的行号被忠实转写，非记录失实；条目实质（全脚本仅 :236 一处 `trap … EXIT`、无 SIGINT/SIGTERM/SIGHUP 处理）对码成立且原样保留 | Wave 2 执行时以届时实际行号为准；与 F-H1 一并校正 |
| 备注-1 | — | 派单笔记称拒绝文案在"67 行"：实测 :67 为 No implicit default 注释块的一行（"(backup_retention_days), the exact two-component drift…"），文案 `echo` 本体在 **:70**。三层化与 #391 指向的内容判定不受影响，疑为派单转写时取了相邻注释块行号，记录供留档 | 无需动作 |
| 备注-2 | — | 单独运行 `bun test ./tests/memory-sensitivity.test.ts` 同样必需 `TEST_DATABASE_URL`（文件经 `tests/support/database.ts` 在模块顶层连接测试库，缺 env 报 "TEST_DATABASE_URL must point at a dedicated PostgreSQL test database" 的 between-tests error）；我初跑漏带 env 得 1 error，带 env 复跑精确得 7/0/100。附录口径成立，此仅为环境要求备忘 | 无需动作 |

## 6. 总体判定

**PASS。** OCR 轮 8 修复批次（3 medium：sensitivity 三类凭据形状 + backup.sh stale 判定 EPERM 误判 + 缺声明文案双层误导）经独立复跑全部证实真正解决：sensitivity.ts 三类新形状 25 用例抽查全过（含任务指定反例与词表形态停用词护栏抽查，9 字母越界与真值边界双侧成立），测试面 +16 断言精确落账；backup.sh 无 flock 回退经 /tmp 演练实证"死 PID 锁被偷后 sweep 照跑（超龄备份被删）、当前存活 PID 锁被拒且锁文件未被破坏、拒绝路径不触发 sweep"，EPERM 分支按任务许可以静态逻辑 + ps 双向语法实测闭合并如实记录；:70 三层文案与 config.ts 实际读取范围（仅进程 env、1..30 域、null 即报 `backup_retention_days`）静态逐句一致且行为复现。23 文件 sha256 全表零偏差（verify-health.ts 保持 ocr7 终值），变化集恰为 3 代码文件 + 2 报告只追加（改前哈希链与 ocr6/ocr7 旧链双向复现），零夹带；规范 12 文件套件（F-C1 逐字清单）104/0/436、hindsight 27/0/62、单文件 7/0/100、tsc 0、bash -n 通过、biome 2 文件 0 问题；Wave 2 八条 low（server 4 + deploy 4）逐条对码如实且原样未修。仅 1 info（Wave 2 行号转写漂移，源头在 OCR 对改前快照的输出）+ 2 条备注（派单"67 行"为注释块行号；单文件测试的 env 要求），无阻塞。工作区隔离卫生（HEAD 不变、git status 不变、真实容器零触碰、/tmp 探针全清、审阅窗口 mtime 0 命中）。

— 审阅完成于只读工作区，未改动任何被审文件（本报告除外），未 commit/push。
