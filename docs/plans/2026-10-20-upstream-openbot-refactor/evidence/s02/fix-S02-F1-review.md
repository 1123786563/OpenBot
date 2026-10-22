# S02-F1 独立 Review：mysql 规则大小写敏感修复

- Reviewer：独立 reviewer（S02-F1 聚焦复审），2026-10-20。
- 工作区：`.worktrees/upstream-openbot-update`（HEAD = `3b4a7c68`，未 commit 树）。
- 审查对象：`server/src/telemetry/scrub.ts` mysql 规则 flags `gi`→`g` + 3 行注释；`server/tests/enterprise-controls.test.ts` 新增 1 用例（含 1 行注释）。
- 方法：只读 + 只读探针（bun -e 导入 scrubCommand、隔离 /tmp 重建 pre-fix 版本对照）+ 复跑验证命令；除本报告外零写入，未 commit/stash/push。

## Review 过程证据（独立取得，非转抄实现者报告）

1. **F1 delta 精确隔离**：把 HEAD 版 scrub.ts 放入 /tmp 临时 git 仓库、apply `evidence/s02/scrub.diff`（S02 修复后状态）重建 pre-fix 文件，与当前文件 `diff -u`：差异**恰好**为 mysql 规则 `gi`→`g` + 3 行分歧注释，其余字节全同。`evidence/s02/after-tracked.diff` 与当前 `git diff`（5 文件）逐字节一致，证据快照未过期。
2. **上游对照**：`evidence/upstream-sources/server/src/telemetry/scrub.ts:60` 确为 `/gi`；pre-fix 本地状态与上游逐字节一致（scrub.diff 第 24 行 `+/gi,`）。
3. **finding 双重复现（pre-fix 探针，/tmp 副本）**：
   - `mysql -h db -P3306 -phunter2 app` → `mysql -h db -P[REDACTED] -phunter2 app`（端口被吞、真密码存活，与 ocr-round-1b 一致）。
   - `MYSQL -h db -phunter2 app` → `MYSQL -h db -p[REDACTED] app`（见 F1 观察）。
4. **post-fix 探针（当前文件，bun -e）**：
   - finding 原例 → `mysql -h db -P3306 -p[REDACTED] app`（端口保留、密码脱敏）。
   - `mysql -phunter2 -P3306 app` → `-p[REDACTED]`、`-P3306` 保留。
   - `mysqldump -P3306 -phunter2 db` → 端口保留、密码脱敏。
   - 同行双命令 `mysql … -phunter2 && mysql -P3307 … -pwelcome` → 两处密码均脱敏、两个端口均保留（`g` 可在后续 `\bmysql\b` 锚点再次命中；`[^|;&]` 阻止扫描越过 `&&`）。
   - 反斜杠续行 `mysql -uroot \<LF> -P3306 -phunter2 db` → 密码脱敏、端口保留。
   - 换行边界 `mysql -uroot appdb<LF>ssh -p2222 …` → 第二行端口原样。
   - 空格 `-p hunter2`（提示输入形态）原样——既有负例不回归。
5. **RED 独立复证**：从 enterprise-controls.test.ts 逐字提取 `describe("scrubbing commands")` 块（37 case 循环 + 3 具名 test = 40 tests），分别对 pre-fix / post-fix 模块运行：pre-fix **39 pass / 1 fail，唯一失败即新增用例** `mysql -h db -P3306 -phunter2 app`；post-fix **40 pass / 0 fail**。该文件其余 ~18 个 test 不引用 scrubCommand，不受本改动影响——实现者"58 中 1 failed 为新增用例"的 RED 口径可信。
6. **format 漂移归因**：对 `git show HEAD:` 的 BASE 字节跑 `bunx biome format --stdin-file-path`，产生与当前完全相同的第 1 行 import 拆分要求——enterprise-controls.test.ts 唯一的 format 错误为 BASE 既有，非 F1 引入。

## Findings

### F1（Info，接受，登记为残留风险）：大写命令拼写不再命中 mysql 规则
去掉 `i` 后 `MYSQL`/`MySQL` 等非全小写命令名不再锚定规则（探针实证：pre-fix 对 `MYSQL -h db -phunter2 app` 会脱敏，post-fix 原样）。评估为可接受：(a) 实际二进制名为全小写，`MySQL` 是产品名不是命令拼写；(b) 同组 sshpass 规则（`/g`，"Case matters here"）本就采用同一标准；(c) 上游 `gi` 在 finding 场景自相矛盾——吞端口、放真密码，"覆盖"是负资产。若未来需要兜底可考虑 `[mM]ysql` 类折中，非本票义务。

### F2（Info，核对无误）：裁决依据四项全部属实
- A02：`docs/specs/2026-10-20-upstream-openbot-adoption-design.md:122`"指定参数秘密不进入实际 OTLP body"。
- 更强证据：UP02 票据（`docs/tickets/upstream-openbot-update/issues/up02.md`）验收标准明文"**区分密码选项与端口/数据库参数**"——上游 `i` 直接违反已批准票据标准，而"逐字节一致"在 Spec 与票据中均无出处，仅为实施纪律手段。裁决（手段让位于验收标准）成立且比 brief 表述更充分。
- 模块头 "a secret that survived costs a rotation"（scrub.ts:10-11）在案。
- sshpass 同组 `/g` + "Case matters here" 标准一致。

### F3（Info，核对无误）：分歧登记完整
scrub.ts:59-61 注释明示 "Case-sensitive on purpose, unlike the upstream source"，写明大写 `-P` 端口语义与上游 `i` 的双重后果（吞端口 + 放过同命令行后续真密码）；ledger §7 Ruling S02-F1 在案；向上游反馈登记为建议（对外动作未越权）。测试文件第 48 行注释同步钉住语义（"only the lowercase flag reads as one"）。

### F4（Obs，不处理）：redis-cli/docker 规则仍保留 `i`
属上游原状、F1 brief 明确"不得改动其他规则"，本次未动是正确执行而非遗漏；其中 docker 规则由 `docker login` 子命令锚定、`-P` 非其端口语义，风险量级与 mysql 不同。如需评估留独立后续。

## 验证命令与结果（reviewer 本机复跑）

| 命令 | 结果 |
| --- | --- |
| `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/enterprise-controls.test.ts` | **58 passed (58)，0 failed** |
| `bun test ./server/tests/otel-export-scrubbing.test.ts` | 1 pass / 0 fail（5 expect） |
| `bun test ./server/tests/enterprise-controls.integration.test.ts ./server/tests/credential-rotation-leak.integration.test.ts` | 23 pass / 0 fail |
| `bunx biome format server/src/telemetry/scrub.ts` | exit 0 |
| `bunx biome lint --error-on-warnings server/src/telemetry/scrub.ts` | exit 0 |
| `bunx biome format server/tests/enterprise-controls.test.ts` | exit 1，唯一差异 = 第 1 行 import 拆分（BASE 既有，见过程证据 6），F1 新增行无新违规 |

diff 范围核对：相对 S02（pre-F1）状态，行为改动仅 mysql 规则 flags 一处 + 注释 3 行 + 测试新增 2 行（75→77 插入）；其余 S02 规则与测试零改动。

## 结论

修复恰好解决 finding（端口不再误脱敏、同命令行真密码被脱敏），未引入新漏脱敏路径（去 `i` 只能缩小匹配集，唯一缩小面见 F1 观察，量级可接受且有同组标准支撑）；测试用例钉住了端口保留 + 密码脱敏的可观察行为，RED 证据经隔离复证可信；分歧登记（源注释 + ledger §7 + 报告）完整，裁决依据经独立核实成立（UP02 验收标准直接支持）；全量回归 58/58 绿，邻域测试绿，diff 范围最小且与证据快照一致。

Spec compliance: pass
Code quality: pass
