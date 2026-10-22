# Task Brief S02：命令参数凭据脱敏与 OTLP 证明

- **Task/AC**: S02 / A02。正式 Issue：[#491](https://github.com/1123786563/OpenBot/issues/491)（本地票 `docs/tickets/upstream-openbot-update/issues/up02.md`）。
- **owner_role**: backend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`，分支 `upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push。

## 事实源

1. Spec §2 第 2–3 条：参数脱敏以具体命令语义识别 docker login、sshpass、redis-cli、mysql、curl 上游覆盖形态；保留现有 token/header/JSON/URL 脱敏；不承诺净化任意 shell 语法或追溯历史日志。
2. 上游参考（只读）：`evidence/upstream-sources/server/src/telemetry/scrub.ts`。与本地 `server/src/telemetry/scrub.ts` 的差异即本次移植范围：
   - **新增 4 条工具锚定规则**（置于通用规则之前，理由见上游注释）：mysql 附着形式 `-psecret`；`docker login -p secret`；`sshpass -p secret`（含 -f/-d/-P 自身选项与大小写处理）；`redis-cli -a secret / -asecret / --pass secret`。各规则拒绝以 `-` 开头的值（裸 flag 不吞后续 flag），命令边界为换行（反斜杠续行视为同一命令）。
   - **删除旧通用 mysql 规则** `(\bmysql(?:dump)?\b[^|;&]*?\s-p)(\S+)`（会误吞 `mysql -p database`）。
   - curl 用户规则增加 `--proxy-user`；刻意不含 `-U`（上游注释说明理由）。
   - URL userinfo 规则用户名部分 `+`→`*`（支持 `redis://:pass@host` 密码-only 形式）。
3. 本地 `scrubCommand(command:string):string` 签名保持不变；scrubber 是文本变换，不解析为真实 shell。

## owned_files

- `server/src/telemetry/scrub.ts`
- `server/tests/enterprise-controls.test.ts`
- `server/tests/otel-export-scrubbing.test.ts`

## 要求（RED→GREEN→REFACTOR）

1. **RED（enterprise-controls.test.ts）**：新增上游参数形态用例——docker `login -p secret`、sshpass `-p secret`、redis-cli `-a secret`/`-asecret`/`--pass secret`、mysql 附着 `-psecret`、curl `--proxy-user user:pass`、带引号的秘密值（secret 值须不符合已知 token 前缀，明显虚构）。负例：`mysql -p database` 不把 database 当密码；`docker -p 8080:80` 不是秘密；裸 `-p` 不吞后续 flag；既有 --password、token、JSON body、URL userinfo 脱敏回归保持。
2. **GREEN**：按上游差异最小移植规则；不改 `scrubCommand` 导出与调用点。
3. **V-B（otel-export-scrubbing.test.ts）**：真实本地 OTLP collector 收到的 body 不含 fixture secret，事件类型/动作关联字段保留；该 suite 为 Bun 驱动层：`bun test ./server/tests/otel-export-scrubbing.test.ts`。
4. **V-N**：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/enterprise-controls.test.ts`。
5. 与 #94/#11 邻域协调：只做参数补丁，不动 Opik 投影或多租户回归结构；发现共享文件冲突写进报告。

## 禁止

- 不宣称净化任意 shell 语法；不追溯改写历史日志。不修改其他文件/ledger/docs。fixture 秘密全部虚构。

## 报告

`evidence/s02/implementer-report.md`：改动摘要、RED/GREEN 证据（命令+用例数）、本次覆盖的命令形态清单、负例清单、偏差。
