# S02 Implementer Report：命令参数凭据脱敏与 OTLP 证明

- 执行角色：backend_implementer；日期 2026-10-20。
- 工作区：`.worktrees/upstream-openbot-update`（分支 `upstream-openbot-update`，改动期间 HEAD = `3b4a7c68`）。未 commit、未 stash、未 push。`git status --short` 中 tracked 修改除本次 owned 三文件外，仅有 S01 已在场的 `server/src/config.ts`、`server/tests/config.test.ts`（未触碰）；无共享文件冲突，#94/#11 邻域（Opik 投影、多租户回归）未动。

## 改动摘要

| 文件 | 改动 |
| --- | --- |
| `server/src/telemetry/scrub.ts` | +42/-9：新增 4 条工具锚定规则（mysql 附着 `-psecret`、`docker login -p secret`、`sshpass -p secret`、`redis-cli -a/-asecret/--pass`，置于通用规则之前）；删除旧通用 mysql 规则 `(\bmysql(?:dump)?\b[^|;&]*?\s-p)(\S+)`；curl 规则增加 `--proxy-user`（刻意不含 `-U`）；URL userinfo 用户名部分 `+`→`*`（支持 `redis://:pass@host`）。`scrubCommand` 导出签名与全部调用点（`controls.ts`、`otel.ts`）未变。 |
| `server/tests/enterprise-controls.test.ts` | +75 行（纯插入，首个 hunk 起于第 399 行）：cases 表新增 22 条（12 正例 + 10 负例），另加 2 条多行独立用例（反斜杠续行、换行命令边界）。 |
| `server/tests/otel-export-scrubbing.test.ts` | +6 行：payload 新增 `login.command`（`docker login -p <secret2>`），断言增加事件类型 `computer.action_allowed` 与 `not.toContain(secret2)`。 |

实现与上游参考 `evidence/upstream-sources/server/src/telemetry/scrub.ts` 逐字节一致（`diff` 为空）；改动即 brief 列出的四条差异，无多无少。

## RED（先失败）

命令（同验证命令）：

```
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/enterprise-controls.test.ts
bun test ./server/tests/otel-export-scrubbing.test.ts
```

RED 输出：**14 failed | 43 passed (57)**。失败用例恰为新增参数形态 + 换行边界负例：

- `docker login -p glorbwibble registry.example.test`（secret 原样存活）
- `docker login -p "glorb wibble" registry.example.test`
- `sshpass -p glorbwibble ssh …`、`sshpass -p 'glorb wibble' ssh …`、`sshpass -P authprompt -p glorbwibble ssh …`
- `redis-cli -a glorbwibble ping`、`-aglorbwibble`、`--pass glorbwibble`、`--pass=glorbwibble`
- `redis-cli -aMY_TOKEN_VALUE ping` —— 旧代码输出 `redis-cli -aMY_TOKEN_VALUE [REDACTED]`：通用 flag 规则把 `-aMY_TOKEN_VALUE` 当成名为 `asecret…` 的旗标，误吞了后面的 `ping` 而放走真密码（上游注释所述顺序问题的实例）
- `curl --proxy-user admin:glorbwibble …`、`--proxy-user=admin:glorbwibble …`
- `open redis://:glorbwibble@cache:6379/0`（旧 userinfo 规则要求非空用户名）
- `a line break starts another command, so its -p is a port again` —— 旧代码输出 `ssh -p[REDACTED] deploy@…`：旧 mysql 规则的 `[^|;&]*?` 跨换行把第二行 ssh 的 `-p2222` 端口当密码吞掉

otel RED：**1 fail**，真实 collector 收到的 OTLP body 中 `openbot.payload.login` 含明文 `fixture-glorb-4e6b2a91d5c3`（同 body 内 bearer/token 形态已是 `[REDACTED]`，证明缺口确在参数形态）。既有 43 条（基线 33 + 当场转绿的 guard 10 条）保持通过，失败与既有行为隔离。

## GREEN（最小移植转绿）

应用上游 scrub.ts 后同一对命令：

- e2e：**57 passed (57)**，0 failed（基线 33 + 新增 24）。
- bun：**1 pass，5 expect() calls**（基线 3 个断言）。wire 含 `computer.action_allowed`、`computer_run_command`、`[REDACTED]`，不含两个 fixture secret。

REFACTOR：无——移植为上游逐字版本，无可简化项。

邻域回归：`bun test ./server/tests/enterprise-controls.integration.test.ts ./server/tests/credential-rotation-leak.integration.test.ts` → **23 pass / 0 fail**（含 "off records nothing; on records the command scrubbed"，其锚定的 Authorization 规则未变）。

## 覆盖的命令形态（正例）

1. `docker login -p secret`（裸值；双引号含空格值）
2. `sshpass -p secret`（裸值；单引号值；前面带 sshpass 自身 `-P <prompt>` 选项）
3. `redis-cli -a secret`、`-asecret`、`--pass secret`、`--pass=secret`、附着值含秘密词 `-aMY_TOKEN_VALUE`（守住"工具规则先于通用规则"的顺序）
4. `mysql`/`mysqldump` 附着 `-psecret`（mysqldump 为旧规则已覆盖的回归 guard）
5. 反斜杠续行后出现的附着 `-psecret`（视为同一命令，仍脱敏）
6. `curl --proxy-user user:pass` 与 `--proxy-user=user:pass`
7. URL userinfo 密码-only：`redis://:pass@host`

## 负例（必须原样保留）

1. `mysql -p database`（空格分隔 = 提示输密码，database 不当密码）
2. `mysql -uroot -p --verbose`（裸 `-p` 不吞后续 flag）
3. `docker -p 8080:80 nginx`（无 `login` 子命令的 docker，`-p` 是端口）
4. `docker login -p -u deploy`（裸 `-p` 后跟 flag 不吞）
5. `docker login --password-stdin < creds.txt`（命令内无密码值）
6. `sshpass ssh -p 2222 …`（被包裹命令自己的 `-p` 端口）
7. `sshpass -P authprompt ssh …`（`-P` 是 prompt，非密码，且大小写敏感）
8. `wget -U Mozilla:5 …`（curl 的 `-U` 刻意不收：对 wget 是 UA、对 ssh 无关）
9. 换行开新命令：第一行 mysql（无 `-p`）+ 第二行 `ssh -p2222`，端口不被跨行吞掉

既有回归（未削弱、未删除，全部继续通过）：bearer/x-api-key header、`GITHUB_TOKEN=`/`AWS_SECRET_ACCESS_KEY=` 赋值、JSON body 三种引号形态、URL userinfo 带用户名、mysql 附着 `-phunter2`、`--password`、`curl -u`/`-uadmin:`/`--user=`/引号对、`sk-` token 形态。

## format / lint 自查（如实）

- `bunx biome format server/src/telemetry/scrub.ts` → **exit 0**。
- `bunx biome format server/tests/otel-export-scrubbing.test.ts` → **exit 1（初查）→ 修正本人新增行（`login:` 对象展开）后 → exit 0**。
- `bunx biome format server/tests/enterprise-controls.test.ts` → **exit 1（初查）→ 修正本人新增的两条超宽单行 case 后仍 exit 1**；残余唯一差异是第 1 行 import 被要求拆分为多行。该行为 **BASE 既有漂移，非本次引入**：`git diff -U0` 显示本次插入起于第 399 行、第 1 行零改动；且对 `git show HEAD:` 的原字节跑项目配置格式化（`--stdin-file-path`，项目根 cwd）产生完全相同的拆分要求（项目行宽 80，该 import 84 字符）。按纪律未触碰 BASE 漂移，本人新增行已全部 format 干净。
- `bunx biome lint --error-on-warnings`（三文件各跑）→ 均 **exit 0**。

## 偏差与备注

1. **brief 负例描述与旧规则实测行为的出入（非 scope 偏差，已按 Spec/上游处理）**：brief 写旧 mysql 规则"会误吞 `mysql -p database`"。实测旧规则 `\s-p` 后必须紧跟 `\S+`，空格分隔的 `mysql -p database` 实际**不**匹配（该负例在旧代码下即绿，本次保留为 guard）。旧规则真实存在的、被本次 RED 证明的误吞是：跨换行吞后续行的附着 `-p`（`ssh -p2222` 被吞）与接受 `-` 开头附着值。新规则按上游以换行为命令边界、拒绝 `-` 开头值，两类误吞都关闭。
2. 无其他偏差：owned_files 之外零改动；`scrubCommand` 签名与调用点未动；fixture secret（`glorbwibble`、`glorb wibble`、`MY_TOKEN_VALUE`、`authprompt`、`fixture-glorb-4e6b2a91d5c3`）全部虚构且不匹配任何已知 token 前缀；未宣称净化任意 shell 语法，未追溯历史日志。

## 追加：S02-F1 修复（OCR r1b finding，medium/security，主控裁决执行）

**问题**：mysql 规则保留 `i` 标志导致大小写误判——探针实证（主控与本次 RED 双重复证）：
`mysql -h db -P3306 -phunter2 app` → `mysql -h db -P[REDACTED] -phunter2 app`（大写 `-P3306` 端口被当密码脱敏；`g` 从首个匹配后继续扫描，剩余文本无 `\bmysql\b` 锚点，真密码 `-phunter2` 存活）。违反 A02 与模块自身准则 "a secret that survived costs a rotation"。

**裁决**（主控，入 ledger §7）：字节一致移植是手段不是 Spec 要求，A02 优先；本地修复，与上游保持**有理由分歧**；向上游反馈为对外动作，仅记录为建议。

**改动**（仅 `scrub.ts` + `enterprise-controls.test.ts`）：

- `scrub.ts`：mysql 规则 flags `gi` → `g`（与 sshpass 规则 "Case matters here" 同组标准一致）；注释补记：大写 `-P` 是 mysql 端口附着形式、本规则刻意大小写敏感、上游 `i` 会把端口当秘密并放过同命令行后续真密码。其他规则零改动。
- 测试新增 1 条正例：`["mysql -h db -P3306 -phunter2 app", "mysql -h db -P3306 -p[REDACTED] app"]`（端口保留、密码脱敏）。

**RED**（先失败）：同 e2e 验证命令 → **1 failed | 57 passed (58)**，唯一失败即新增用例（旧代码输出 `mysql -h db -P[REDACTED] -phunter2 app`，端口被吞、真密码存活），既有 57 条全部保持绿。

**GREEN**：flags 修正后同一命令 → **58 passed (58)**；`bun test ./server/tests/otel-export-scrubbing.test.ts` → 1 pass；邻域 `enterprise-controls.integration` + `credential-rotation-leak.integration` → **23 pass / 0 fail**。

**format/lint 自查（如实）**：`bunx biome format server/src/telemetry/scrub.ts` → **exit 0**；`server/tests/enterprise-controls.test.ts` → 仍 **exit 1**，残余差异仅第 1 行 import 拆分 6 行（BASE 既有漂移，S02 主报告已证明先于本次存在；`git diff -U0` 显示本次插入仍起于第 399 行，第 1 行零改动），S02-F1 新增行无新违规。`bunx biome lint --error-on-warnings` 两文件均 **exit 0**。

**与上游分歧登记**：本地 mysql 规则现为 `/g`（上游 `/gi`），分歧理由已写入规则上方注释；覆盖形态新增"大写 `-P` 端口附着 + 同命令行后续真密码"组合。其余四条差异与上游保持一致（redis-cli 规则的 `i` 属上游原状，未在本次授权范围内改动）。
