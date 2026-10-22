# S02 Independent Review：命令参数凭据脱敏与 OTLP 证明（AC A02，Issue #491）

- Reviewer：独立 reviewer（只读；唯一写入为本报告）。日期 2026-10-20。
- 工作区：`.worktrees/upstream-openbot-update`，HEAD = `3b4a7c68132c3507300408346a44fb9d56f3c14c`（与实施/验证时一致）。
- 审查范围：S02 三文件增量（`server/src/telemetry/scrub.ts`、`server/tests/enterprise-controls.test.ts`、`server/tests/otel-export-scrubbing.test.ts`）。diff 中 `server/src/config.ts`、`server/tests/config.test.ts` 为 S01 已验收在场改动，不在本次审查范围。

## 独立复核记录（全部亲自执行）

| 项 | 命令/方法 | 结果 |
| --- | --- | --- |
| e2e 验收 | `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/enterprise-controls.test.ts` | **57 passed (57)，0 failed** |
| OTLP 验收 | `bun test ./server/tests/otel-export-scrubbing.test.ts` | **1 pass，0 fail，5 expect() calls** |
| 上游一致性 | sha256 本地 vs `evidence/upstream-sources/.../scrub.ts` | 均为 `c2185991…`，**逐字节相同** |
| 证据绑定 | `git diff` vs `after-tracked.diff` | diff 输出为空；validator 报告所列 5 个 sha256 全部复验相符 |
| numstat | `git diff --numstat` | scrub 42/9、enterprise-controls 75/0、otel 6/0，与实施报告一致 |
| RED 真实性 | `git show HEAD:scrub.ts` 提取 /tmp 独立重放 24 条新用例 | **10 pass / 14 fail**，失败清单与实施报告逐条一致 |
| 旧规则行为探针 | HEAD 版 `mysql -p database` / `mysql -p-secretvalue db` | 前者**不变**（证实偏差 1：brief 描述有误）；后者被旧规则**双重误吞**（`-p[REDACTED] [REDACTED]`，证实旧规则真实缺陷形态） |
| 回溯安全 | 7 组对抗输入（~5k 空格、2k 重复 flag、20k 懒扫描等）计时不挂起 | 总计 346ms，量级线性，**无灾难性回溯** |
| format | `bunx biome format` 三文件 | scrub.ts、otel 测试 **exit 0**；enterprise-controls 仅第 1 行 import（BASE 既有漂移，见 F4） |
| lint | `bunx biome lint --error-on-warnings` 三文件 | 均 **exit 0** |
| 邻域回归 | `bun test enterprise-controls.integration credential-rotation-leak.integration` | **23 pass / 0 fail** |

## Findings

无 Blocker / Major / Minor。以下均为 Obs / Info 级。

- **F1（Obs，报告文字，不处理）**：实施报告称 cases 表新增"12 正例 + 10 负例"；按 diff 实数 **14 正例 + 8 负例**（总数 22 正确）。差异在归类口径（`mysqldump` 回归 guard、`open redis://:pass@`、`-aMY_TOKEN_VALUE` 守序用例的归类），validator Obs-1 属实。测试本体与断言全部正确，不影响验收结论。
- **F2（Obs，已正确处理，无需动作）**：偏差 1 证实成立。brief 断言旧 mysql 规则"会误吞 `mysql -p database`"，但 HEAD 版实测该输入**原样通过**（`\s-p` 后须紧跟 `\S+`，空格分隔不匹配）；旧规则真实缺陷形态是跨换行吞后续行 `ssh -p2222`、接受 `-` 开头附着值（探针：`mysql -p-secretvalue db` → `mysql -p[REDACTED] [REDACTED]`）、以及通用规则顺序问题（`redis-cli -aMY_TOKEN_VALUE ping` → 真密码存活、`ping` 被吞，已独立复现）。实现者按 Spec 语义交付了要求的负例（`mysql -p database` 原样保留）并以正确负例清单替换了 brief 的错误描述，处理恰当。
- **F3（Info，上游继承的设计取舍，非缺陷）**：新规则拒绝以 `-` 开头的附着裸值（引号值不受限），因此真实密码恰好以 `-` 开头的极端输入（如 `mysql -p-abc123`）不再被脱敏。这是上游为保护"裸 flag 不吞后续 flag"做出的定向取舍，有负例锚定（`docker login -p -u deploy`），与模块头注释"deliberately over-eager"的例外已由规则注释说明。随上游逐字移植，不应本地分叉。
- **F4（Obs，既有漂移，非本次引入，不处理）**：`enterprise-controls.test.ts` 第 1 行 import（84 字符）不满足 biome 默认 80 列。验证：HEAD 原字节与当前第 1 行逐字节相同；对 HEAD 原字节跑 `--stdin-file-path` 产生完全相同的拆分要求。本次新增行全部 format 干净。归属 V01 统一登记，与两份报告叙述一致。
- **F5（Info，覆盖边界记录）**：规则要求 `login` 紧跟 `docker` + 空白，故 `docker compose login -p secret`（compose v2 透传形态）不在覆盖内；docker/redis/mysql 规则大小写不敏感（`gi`）而 sshpass 刻意大小写敏感（`-P` 是 prompt），不对称已在注释中说明理由。两者均为上游逐字行为，Spec 限定"上游覆盖形态"，不构成本次缺陷；留作后续上游同步时的已知边界。

## 结论摘要

- 移植为上游逐字节版本（sha256 相同），brief 列出的四条差异（4 条工具锚定规则、删除旧通用 mysql 规则、curl `--proxy-user` 且刻意不含 `-U`、userinfo `+`→`*`）全部在位且无多余改动。
- 覆盖与负例完整对应 up02 验收项：五种命令形态 + 引号值、端口/数据库参数区分、裸 flag 保护、既有 token/header/JSON/URL 回归（纯插入、零删除）、真实 collector wire 断言（事件类型 `computer.action_allowed` 与动作 `computer_run_command` 保留、两个 fixture 秘密 `not.toContain`、且不匹配任何 TOKEN_SHAPES 前缀）。
- 报告声明与 diff/源码事实抽查全部相符；两处报告口径问题（F1/F2）与两处既有/上游继承边界（F4/F3、F5）均不影响验收。
- 正则结构无灾难性回溯形态（懒扫描逐字符、互斥首字符；sshpass 重复组每次迭代强制消耗空白 + 非 `-p` flag，`-p` 只能终结重复），并有对抗输入计时实证。

Spec compliance: pass
Code quality: pass
