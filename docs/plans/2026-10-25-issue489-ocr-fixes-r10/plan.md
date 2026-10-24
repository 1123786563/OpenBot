# F10 修复波方案（R10-C7 终裁派生）

依据：`/Users/wuyongjun/trea/OpenBot/.archive/runs/2026-10-23-issue489-orchestration/ocr/r10-adjudication.md`（2026-10-25 R10 终裁：F10-1 security·high 实测坐实、F10-2/F10-3 medium、F10-4 medium；F10-5/6 low 延期 transfers）。

## T18：scrub 引号族结构性修复（F10-1 + F10-2 + F10-3）

**位置**：`server/src/telemetry/scrub.ts`（mysql/mysqldump、docker login、sshpass、SSHPASS=、redis-cli 五规则）+ `server/tests/enterprise-controls.test.ts`。

**修复（设计裁决）**：

1. **消除臂间首字符歧义（ReDoS 根治）**：所有 lead/值臂中的裸单字符回退臂 `["']` 改为带否定前瞻的字面引号臂——双引号 `"(?![^"\r\n]*")`、单引号 `'(?![^'\r\n]*')`（语义：仅当本行内再无同类闭合引号时才把孤立引号按普通字符消费）。目标：每个位置只有一种推导，回溯线性/平方有界。**不得**以缩小功能面代替（未闭合引回收铁、成对引号段整词仍须保持）。
2. **值臂引号类排除换行（F10-2）**：值臂的 `"(?:\\[\s\S]|[^"\\])*"` → `"(?:\\[\s\S]|[^"\\\r\n])*"`；`'[^']*'` → `'[^'\r\n]*'`（与 lead 臂一致；引号内 `\\[\s\S]` 续行语义保留）。
3. **值臂补转义臂（F10-3）**：值臂首个元素与后续元素两处均加入 `\\[^\r\n]`（`\;` `\|` `\&` 属词内字符），使 `-p pa\;ss` 整词脱敏而非截断。注意与 1/2 的臂序无新歧义（反斜杠首字符与引号臂互斥）。
4. 不新增规则、不改 flags、不动 SECRET_NAME 与各规则的非值臂结构；值臂片段抽取共享常量（F10-5 low）**不在本任务**。

**RED→GREEN（全部新用例先 RED）**：

- ReDoS 有界性：对抗输入（如 `mysql ` + `"" `×40 + 尾部不匹配 或更强的 100 对形）在 1000ms 内返回且输出与小区间同语义；同时记录 8/12/16/20/24/40 对的耗时标度表（修复前实测 602.87ms@20 对，修复后须 ≤ 个位数 ms 量级）。
- 换行隔离：`docker login -p "oops\necho "hi"` → 值在行内脱敏，第二行 `echo "hi"` 原样留在记录（不得整行消失）。
- 转义分隔符：`pa\;ss` → `[REDACTED]`（整词）、`mysql -ppa\|ss`、`SSHPASS=pa\;&cmd` 同步；五规则各 ≥1 例。
- **零回退全族**：既有 96 用例全绿 + T9/T14/R2 各对抗族抽验（未闭合引号、`-` 词内保留、分隔符边界、成对引号段整词、转义对 `\"`/`\\`、`-p;whoami` 零脱敏、`fixture-pass-…` 整词等）。

**门**：enterprise-controls（e2e runner）96+GREEN；otel wire 4/4；server tsc 恰 3 BASE；biome owned 净。

## T19：fillSignIn 跨源密码框 take over 对齐（F10-4）

**位置**：`agent-computer/src/sign-in.ts`（fillSignIn 提交密码后的判定）+ `agent-computer/tests/sign-in.test.ts`。

**修复（设计裁决）**：提交密码完成后，页面已跨 origin 且 `refused`（密码框可见）时——无论 codeRequested——按同文件既有跨源惯例（用户名步 298-302、验证码步 327-331）返回 take over 答复（`answer("The sign-in moved to X. Take over the browser to finish signing in there.", true)`），不得再以 `passwordFieldVisible: true` 读作登录被拒。同 origin 的拒绝语义、codeRequested 跨源的既有文案均不得改变。

**RED→GREEN**：新增真实浏览器用例（跨源且密码框可见、无验证码框 → take over 答复、passwordFieldVisible=false、server 侧不会写「probably not accepted」）；既有 29 用例零回退（含迟到码页、成功页、跨源码页、回登录页、慢机过渡态）。

**门**：sign-in Chromium（真调度路径）29→30 全绿；agent-computer tsc 0；biome owned 净；enterprise-controls 96/96 维持（server 无改仍复跑）。

## 检查点与流程

两任务并行（不同文件族，worktree 各自从本方案提交派生）。各：检查点（after-all/increment/status/sha256，全绝对路径 `/Users/wuyongjun/trea/OpenBot/.archive/runs/2026-10-23-issue489-orchestration/checkpoints/`）→ 编排者字节核验 → R1（Claude 双轴）→ 串行集成（剥头 apply+组合树字节核验+门）→ F10 收官门 → Codex f01-r10 完整终审 + OCR R11（**全 16 项覆盖硬约束，429 失败即 resume 重试**）→ R11 终裁 → V03 → C01。
