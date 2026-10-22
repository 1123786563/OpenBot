# S02 Validator Report：命令参数凭据脱敏与 OTLP 证明（AC A02，Issue #491）

- 执行角色：backend_validator；日期 2026-10-20。
- 工作区：`.worktrees/upstream-openbot-update`，验证时 HEAD = `3b4a7c68132c3507300408346a44fb9d56f3c14c`（与实施期间一致，未发生新提交）。
- 验证方式：只读。亲自重跑两条验收命令、对本地 `scrub.ts` 与上游参考做逐字节 diff、将 HEAD（移植前）版本 `scrub.ts` 提取到 `/tmp` 独立重放 24 条新增用例以复核 RED 真实性。未修改任何业务/测试源码，未 commit/stash/push，未派发子 Agent。

## 结论：**PASS（6/6 项通过，0 缺陷，2 条 Obs 级观察）**

## 验证时哈希绑定（sha256）

| 文件 | sha256 |
| --- | --- |
| `server/src/telemetry/scrub.ts`（本地） | `c2185991d29af64953937cd78e4420e2bddef8044392a0cfffc80393749a6169` |
| `evidence/upstream-sources/server/src/telemetry/scrub.ts`（上游参考） | `c2185991d29af64953937cd78e4420e2bddef8044392a0cfffc80393749a6169`（与本地**逐字节相同**） |
| `server/tests/enterprise-controls.test.ts` | `534d4adb128b5c453b516ac89903ee6fbb1d33c65ff3d0a8d136198da49d6b72` |
| `server/tests/otel-export-scrubbing.test.ts` | `e6fcc05ae0e0d24ffa4ae8ceb9b832b01a2ed1ad008b44b5911f4a443744f3dd` |
| `evidence/s02/after-tracked.diff` | `50209b304607206250b7706b9749bc81f74a64488563c2538618b563c841428d`（与验证时 `git diff` 输出 diff 为空，在场状态与证据一致） |

## 逐项验收

### 1. 规则覆盖与上游一致性 — **PASS**

- 亲自运行 `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/enterprise-controls.test.ts` → **57 passed (57)，0 failed**（Duration 876ms，`scrubbing commands` 全绿，含全部新增正/负例与两条多行用例）。
- 亲自运行 `bun test ./server/tests/otel-export-scrubbing.test.ts` → **1 pass，0 fail，5 expect() calls**。
- `diff` 本地 `server/src/telemetry/scrub.ts` 与 `evidence/upstream-sources/server/src/telemetry/scrub.ts` → **输出为空**；sha256 相同（见上表），双重确认逐字节一致。
- diff 抽查（`after-tracked.diff` + 本地文件）确认四项差异全部在位且与上游一致：
  1. 新增 4 条工具锚定规则，置于通用规则（JSON body、`--password/--token` 通用名规则）**之前**，与上游注释的顺序理由（通用规则会把 `redis-cli -asecret` 误读为旗标名）一致：mysql/mysqldump 附着 `-psecret`（scrub.ts:60）、`docker login -p`（:65）、`sshpass -p`（含 `-f/-d/-P` 自身选项与大小写敏感处理，:72）、`redis-cli -a/-asecret/--pass[=]`（:77）。
  2. 旧通用 mysql 规则 `(\bmysql(?:dump)?\b[^|;&]*?\s-p)(\S+)` 已删除（diff 中为纯删除块；本地文件 grep 无残留）。
  3. curl 用户规则增加 `--proxy-user(?:=|\s+)`，刻意不含 `-U`（上游注释在位：`-U` 对 wget 是 UA、对 ssh 无关）。
  4. URL userinfo 规则用户名部分 `+`→`*`（`([^\s/@:]*):`），支持 `redis://:pass@host` 密码-only 形式，注释在位。
- 每条规则均拒绝 `-` 开头值（字符类 `[^\s'"-]`），命令边界为换行（排除 `\r\n`），反斜杠续行（`\\[\s\S]` / `\\\r?\n`）视为同一命令。

### 2. 负例语义 — **PASS**

在 `server/tests/enterprise-controls.test.ts` 中逐条找到对应断言（行号按当前文件）：

| 负例 | 断言位置（diff 行） | 期望 |
| --- | --- | --- |
| `mysql -p database` 不把 database 当密码 | cases 表 `"mysql -p database" → "mysql -p database"` | 原样保留 |
| 裸 `-p` 不吞后续 flag | `"mysql -uroot -p --verbose"` 及 `"docker login -p -u deploy"` | 原样保留 |
| `docker -p 8080:80` 不是秘密 | cases 表 `"docker -p 8080:80 nginx"` | 原样保留 |
| 被包裹 ssh 的端口 `-p 2222` | `"sshpass ssh -p 2222 deploy@host.example.test"` | 原样保留 |
| sshpass 自身 `-P`（prompt，非密码，大小写敏感） | `"sshpass -P authprompt ssh deploy@host.example.test"` | 原样保留 |
| `wget -U`（curl 规则刻意不收 `-U`） | `"wget -U Mozilla:5 https://example.test"` | 原样保留 |
| 换行开新命令 | 独立用例 `"a line break starts another command, so its -p is a port again"`（`mysql…\nssh -p2222`） | `ssh -p2222` 原样保留 |

既有回归无削弱：`git diff` 对两个测试文件均为**纯插入**（`git diff --numstat`：enterprise-controls `75 0`、otel `6 0`；删除行计数为 0）。基线断言全部在场：bearer/x-api-key header、`GITHUB_TOKEN=`、`AWS_SECRET_ACCESS_KEY=`、`sk-proj-` token、JSON body 三种引号形态、`mysql -uroot -phunter2`、`tool --password hunter2 --verbose`、`curl -u`/`-uadmin:`/`--user=`/引号对、`psql postgres://app:hunter2@…`（带用户名 userinfo）。

### 3. OTLP 证明 — **PASS**

- `server/tests/otel-export-scrubbing.test.ts` 使用**真实本地 collector**（`Bun.serve` 于 `127.0.0.1`、`port: 0`，`fetch` 中 `await request.text()` 收实际 wire body），不是 mock 断言。
- fixture 秘密 `fixture-value-7f3a91c0d2` 与 `fixture-glorb-4e6b2a91d5c3` 明显虚构，逐一对照 `scrub.ts` 的 `TOKEN_SHAPES`（11 条前缀形态）均不匹配。
- 断言完整：`wire` 含 `[REDACTED]`，**不含**任一 fixture secret（`not.toContain` × 2）；事件类型 `computer.action_allowed` 与动作关联 `computer_run_command` 均断言保留。嵌套 `login.command` 经 `otel.ts` `scrubCommands`（`key === "command"` 路径）调用同一 `scrubCommand`。
- 补充证明（validator RED 重放）：HEAD 版规则下 `docker login -p fixture-glorb-…` 的秘密**原样存活**（=true），而 bearer 形态已被旧规则脱敏（=false）——与实施报告"RED 时 body 中 bearer 已是 `[REDACTED]`、缺口确在参数形态"的叙述吻合。

### 4. 范围 — **PASS**

- `git status` tracked 修改恰 5 个文件；其中 S02 owned 三文件：`server/src/telemetry/scrub.ts`、`server/tests/enterprise-controls.test.ts`、`server/tests/otel-export-scrubbing.test.ts`。另两个 `M`（`server/src/config.ts`、`server/tests/config.test.ts`）为 S01 已验收在场改动（S01 validator-report 在场、ledger 中 S01=verified），不计入本任务。
- `scrubCommand` 签名未变：HEAD 与当前均为 `export function scrubCommand(command: string): string`；调用点 `server/src/admin/controls.ts`（:313、:787）与 `server/src/telemetry/otel.ts`（:97）所在文件**不在**改动列表。
- 无 Opik 投影改动：`server/src/ai-observability/*`（opik-port.ts 等）全部未触碰；无多租户结构改动：`organization-*`、`tenant-*`、`multitenancy/` 未触碰。

### 5. RED 真实性 — **PASS（独立重放证实）**

验证者未信任报告文字，而是把 `git show HEAD:server/src/telemetry/scrub.ts` 提取到 `/tmp/s02-red-check/`（零 import、可独立运行），对 24 条新增用例做重放：

- 结果 **10 pass / 14 fail**，与报告"14 failed | 43 passed (57)"精确吻合（43 = 33 基线 + 10 条旧规则下即绿的用例）。
- 14 条失败清单与报告所列**逐条一致**，且两条关键误吞行为被独立复现：
  - `redis-cli -aMY_TOKEN_VALUE ping` → 旧规则输出 `redis-cli -aMY_TOKEN_VALUE [REDACTED]`（通用旗标规则吞掉后面的 `ping` 而放走真密码），与上游注释所述顺序问题实例吻合。
  - 换行边界 → 旧规则输出 `ssh -p[REDACTED] deploy@…`（`[^|;&]*?` 跨换行吞第二行 `ssh -p2222`）。
- 反斜杠续行用例在旧规则下即绿（旧规则本就跨行匹配），属报告所述"当场转绿的 guard"，口径一致。
- 失败原因均为**缺失规则**（秘密原样存活），而非断言构造错误——每条失败输出与期望的差异恰是 `[REDACTED]` 未发生。

### 6. 邻域协调 — **PASS**

- `git diff --name-only` 仅为上述 5 文件；#94（Opik 内容投影）的 `server/src/ai-observability/*` 与 #11（多租户回归）的 `organization-*`/`tenant-*`/`multitenancy/` 文件**零触碰**。
- 实施计划文件边界表中"配置/导出"单元即 `config.ts` + `scrub.ts`，归 S01/S02；无其他在途任务声明拥有 S02 三文件，无共享文件冲突。

## 问题分级

无 Blocker / Major / Minor。

- **Obs-1（报告措辞，不处理）**：实施报告称 cases 表新增为"12 正例 + 10 负例"；按 diff 实数为 14 正例 + 8 负例（总数 22 正确，仅正/负归类口径不同——如 `open redis://:pass@` 与 `mysqldump` guard 的归类）。不影响验收结论。
- **Obs-2（既有漂移，非本次引入，不处理）**：`enterprise-controls.test.ts` 第 1 行 import 不满足 biome 80 列。验证者对照 `git show HEAD:` 原字节跑 `bunx biome format --stdin-file-path` 产生**完全相同**的拆分要求，证实为 BASE 既有漂移；本地新增行 format 干净（`bunx biome format` 对 scrub.ts、otel-export-scrubbing.test.ts 均 exit 0）。与实施报告的自查叙述一致。该漂移归属 V01 统一登记。

## 验证命令与输出汇总

| 命令 | 预期 | 实测 |
| --- | --- | --- |
| `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/enterprise-controls.test.ts` | 57 passed | **57 passed (57)，0 failed** |
| `bun test ./server/tests/otel-export-scrubbing.test.ts` | 1 pass | **1 pass，0 fail，5 expect() calls** |
| `diff server/src/telemetry/scrub.ts evidence/upstream-sources/server/src/telemetry/scrub.ts` | 空 | **空**（sha256 亦相同） |
| HEAD 规则重放 24 条新用例（/tmp 独立脚本） | 14 fail | **10 pass / 14 fail，失败清单与报告一致** |
| `bunx biome format` 三文件 | 新增行干净 | scrub.ts / otel 测试 exit 0；enterprise-controls 仅剩 BASE 第 1 行既有漂移 |
