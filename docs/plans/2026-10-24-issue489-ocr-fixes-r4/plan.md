# #489 F04 修复波方案（R4 OCR 六 finding）

Run `run_000fcaac3873`（#489 编排）。输入 = F02 OCR R4 全范围重做（分段A/B/C′）逐条终裁，裁决表 `.archive/runs/2026-10-23-issue489-orchestration/ocr/r4-adjudication.md`（相对主 checkout `/Users/wuyongjun/trea/OpenBot`）。基线 = 集成分支 HEAD `ed4da96345`（4f88d9b310 → 27bdc381a3 → 39eb41c30a → 61496fbac6 → 68083738c0 → ed4da96345）。

## 全局约束（沿 F03）

- 四任务 owned_files 互不相交，并行派发（活跃任务 Worktree ≤4）。
- 实施 Worker（Pi）**无提交授权**：交付=未提交检查点（全树 diff + 相对基线净增量 + status，SHA-256 记录），产物写 `.archive/runs/2026-10-23-issue489-orchestration/checkpoints/`，报告写 `reports/`。
- 每个 finding 修前先写 RED 用例（能证明缺陷存在），修后 GREEN；既有语义不回退（对抗表沿 T8a 先例）。
- 修完走独立 Claude R1 审核（Spec+质量双轴）→ 编排者串行集成（git apply + 哈希核验 + 组合树验证 + 提交）。
- 治理边界不变：公司/团队、审批、Payer、Hindsight、Mastra 为既定权威；不触碰转交清单事项（MT050 三件套、并行线、journal 约束）。

## T10a scrub 双修（F04-4 medium + F04-6 **high**）

owned：`server/src/telemetry/scrub.ts`、`server/tests/enterprise-controls.test.ts`、`server/tests/otel-export-scrubbing.test.ts`。

1. **F04-6 sshpass 终止符回归**（:94，T8a 引入）：终止符 `-[^\sfdP]*p` 集群类未排除 `p`，贪婪回溯使 `p` 可落在附加口令内部——实测 `sshpass -phunter2p ssh user@host` → 口令完整留存于 lead、`ssh` 被误抹（编排者 node 实测坐实）。修复：集群类排除 `p`，即 `-[^\sfdPp]*p`（实测七例全对：`-vp`/`-pp`〔口令=p〕/`-Pprompt`/`-f file`/`-P3306` 语义保持）。补对抗用例：附加口令含 `p`（`-phunter2p`、`-papple`）、口令恰为 `p`（`-pp`）、组合簇（`-vp`）、`-P` prompt 前置。
2. **F04-4 四规则值分支吞命令分隔符**（:68 一带）：mysql/mysqldump、docker login、sshpass、redis-cli 的裸值分支 `[^\s'"-]\S*` 中 `\S*` 不排除 `;|&`——`docker login -p pass;whoami` 把 `pass;whoami` 整体脱敏，后续命令从遥测消失（过度脱敏=取证盲区；shell 语义上 `;` 前即口令边界）。修复：裸值分支尾段改为不跨 `;|&`（如 `[^\s'"-][^\s;|&]*`），引号分支不动（引号内分隔符属口令本体，T8a 已闭合）。**同形扩展（申报后修）**：`SSHPASS=` 规则裸值臂 `[^\s'"]+` 同根因同修，方法与理由写进注释。对抗用例：`docker login -p pass;whoami`、`mysql -p pw|tee log`、`redis-cli -a pw&&ls`、含分隔符引号口令不回退。

验证门：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts otel-export-scrubbing enterprise-controls`（仓库根跑；含新用例全绿）；`cd server && bunx tsc --noEmit`（≤3 条 BASE 存量红，零新增）；`bunx biome check` owned 文件。

## T10b passwords 租约过期审计（F04-5 medium）

owned：`server/src/passwords/service.ts`、`server/tests/passwords-sign-in.test.ts`。

`load()` 的 filling 租约过期关闭（:177-195，filling→failed/UNKNOWN_OUTCOME）仅 `transition`+`resolved()`，不写任何审计行——「每个结束都有审计」不变量在该路径未闭合（T8a 已闭合尝试侧 superseded 补写；行侧结束在尝试挂死/成功后 CAS 失败 throw/进程中断时零痕迹；`resolved()` 只恢复等待回合）。修复：该关闭分支补写一笔 `computer.sign_in_failed`（系统/服务端 actor 语义——actor 形态参照本文件 landUnknown :300-325 的门控与构造，payload 需能区分「租约过期关闭」与尝试失败〔如 failure=UNKNOWN_OUTCOME 文案、superseded 不标〕），注释写明不变量；不动 load() 调用方契约。测试：并发关闭场景（沿 T8a superserved 用例的注入手法）断言关闭路径自身留有审计行；既有 40 用例不回退。

验证门：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts passwords-sign-in computer-sign-in-code`；tsc/biome 同上。

## T10c markCodeField 误报 + 渲染期写 ref（F04-1 + F04-2 medium）

owned：`agent-computer/src/sign-in.ts`、`agent-computer/tests/sign-in.test.ts`、`app/src/components/computer/use-auto-watch-screen.ts`、`app/tests/auto-watch-screen.test.tsx`。

1. **F04-1**（:162-190 + :320）：markCodeField 回退启发式 `/code|otp|totp|2fa|mfa|verif|passcode/i` 命中 countryCode/postalCode/promoCode 等业务字段，再经 `passwordFieldVisible: codeRequested ? false : refused`（:320）把被拒登录误报为「要求验证码」。修复：回退启发式收紧——命中词须为字段语义主体（排除 country/postal/promo/zip/area/dial/referral/voucher/coupon/discount 等业务前缀的 `*code` 形态；`autocomplete="one-time-code"` 主优先级不变）；若能在不引入 DOM 位置脆弱性的前提下加组合面护栏（refused 且密码框仍在的场合不判 codeRequested）可一并做，做不到只修启发式并注释边界。对抗用例：countryCode+refused 登录不误报、真 one-time-code 字段仍命中、promoCode 不命中。
2. **F04-2**（:47-48）：渲染体 `latest.current = { watching, busy, open, close }` 违反纯渲染（并发模式丢弃/重放渲染写入未提交值，订阅回调读到撕裂状态）。修复：移入无依赖 `useEffect`（每次提交后同步，标准 latest-ref 模式），订阅读取点不动。测试：auto-watch-screen 套件全绿（渲染/事件时序不回退）。

验证门：`cd agent-computer && bun test tests/sign-in.test.ts`（原生直跑，含新用例）；`E2E_UNIT_SCOPE=app bunx e2e run --config e2e.unit.config.ts auto-watch-screen`（仓库根）；agent-computer 与 app 各自 tsc/biome owned 文件零新增。

## T10d tokenHeaderFor 死重复收敛（F04-3 medium）

owned：`server/src/plugins/catalogue.ts`、`server/tests/plugin-catalogue.test.ts`、`server/tests/web-research.test.ts`、`server/tests/plugin-store.integration.test.ts`（仅注释订正，若涉及）。

`tokenHeaderFor`（catalogue.ts:490）全仓无生产调用方（仅测试引用；store.ts:914 注释对照），线上头名决策=store.ts `deploymentTokenHeader`（:922，未导出）——同段 tri-state 逻辑两份实现，漂移风险。修复（优先级序）：(1) 若存在可观测 store 行为缝（如 plugin-store 集成测试路径能观察头名），删除 tokenHeaderFor 并把 tri-state 断言改钉到该缝；(2) 否则从 store.ts 导出 deploymentTokenHeader，测试改钉它，删除 catalogue 侧重复。两种都须：生产路径零变化、tri-state 断言语义等价迁移（x-api-key/Authorization/自定义三态）、注释（store.ts:914 与 plugin-store.integration.test.ts:8354）同步订正不再指向死函数。

验证门：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts plugin-catalogue web-research`（若 runner 不收集则 bun 直跑并申报）；`grep -rn tokenHeaderFor` 于 server/src 归零（或仅存导出处）；tsc/biome 同上。

## 集成与后续

- 集成顺序（编排者）：方案提交 → T10a → T10b → T10c → T10d（每步 git apply 干净 + 哈希核验 + owned 文件对基线 diff 一致 + 组合树门），任一失败回该任务整改。
- 全部集成后：F01-R4 Codex 完整终审（4f88d9b310..新 HEAD + F04 四提交增量）→ OCR R5 全范围重做（A/B 不变 + C″ 全量增量）→ V03 终版裁决 → C01「验收完成、待关闭」。
