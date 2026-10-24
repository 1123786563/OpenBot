# F08：R7-C4 两条有效 medium 修复（T14+T15）

来源：OCR R7-C4 终裁（`/Users/wuyongjun/trea/OpenBot/.archive/runs/2026-10-23-issue489-orchestration/ocr/r7-adjudication.md` 分段 C4；原文 `ocr/r7-chunkC-4f88d9b310-28a0048d0.md`）。编排者双版本活体复现与机制机判均已归档。

## T14：scrub lead 引号臂转义感知（security medium，修复面回归）

指控：T10a-R2 为 lead 加引号透传 arm 时用 `"[^"\r\n]*"`，不识别引号内转义引号——`docker login -u "dev\"ops" -p hunter2` 中悬空引号卡死 lead 推进，整条规则失配，hunter2 原样进入审计/遥测（BASE 旧 lead 引号作普通字符通过、会脱敏；R2 审核 36 例未采 `\"` 形态）。

修复：受影响 lead 的双引号臂改转义感知 `"(?:\\[\s\S]|[^"\\\r\n])*"`（单引号臂保持——shell 单引号内无转义）。**lead 清单须全量盘点**：mysql/mysqldump（:78）、docker login（:85 附近）及任何同型 lead（redis `-a` 等，以 grep `"[^"` 全文件清单为准）；值臂（quoted 值透传）语义不动（BASE 同态设计边界，已转交另裁）。既有 36+ 例语义零回退。

owned：`server/src/telemetry/scrub.ts`、`server/tests/enterprise-controls.test.ts`、`server/tests/otel-export-scrubbing.test.ts`。

RED：裸 HEAD+仅测试增量，新增 `\"` 对抗例（docker/mysql lead 整值泄漏形 + redis 形）恰 failed；GREEN 后门：enterprise-controls 全绿（沿 T10a 口径）、otel scrub bun 4/4、server tsc 恰 3 条 BASE、biome owned 净。

## T15：askVerdicts 前缀预筛（perf medium，缓存目标场景失效）

指控：512 条 FIFO（`keys().next()` 淘汰、无命中触碰）+ groupToolSteps 旧→新逐帧全扫——D>512 条不同结果时稳态全 miss，每帧对全部历史结果完整 JSON.parse；注释「a frame no longer re-reads history it has already judged」在长 research 会话（缓存的目标场景）被证伪。

修复：`asksThePerson` 入口加零成本前缀预筛——`result.trimStart()` 既不以 `REFUSAL_MARKER` 也不以 `JSON.stringify` 编码形态 `` `"${REFUSAL_MARKER}` `` 开头 ⇒ verdict 必 false，直接返回（不 parse、不进缓存；依据 asText 仅改写引号开头字符串的既定语义，注释写明推理）。refusal（稀少短小）照旧走缓存。顺带消解「按条数不按字节驻留」low。既有 29 例零回退。

owned：`app/src/components/channels/tool-activity.tsx`、`app/tests/tool-activity.test.tsx`。

RED：裸 HEAD+仅测试增量——>512 条不同非 refusal 结果的场景断言 parse 面为零/极小（实现方式自选：可测 verdict 语义（非前缀形恒 false）+ 可观测 parse 计数（stub JSON.parse 计数）双轨），恰 failed；GREEN 后门：`bun test ./app/tests/tool-activity.test.tsx` 全绿（29 既有+新例）、app tsc 裸基线/工作树 62 条 BASE 逐字节一致、biome owned 净。

## 共同约束

实施=Claude（用户绑定）；TDD（RED 证据先落报告）；检查点与报告写主归档绝对路径（briefs 同 F07 惯例：after-all/increment diff+status+逐文件 SHA-256）；不 commit/push；不派子 Agent；owned 互斥；两任务并行（K=4 内）。集成后：Codex 完整终审重派（4f88d9b310..新 HEAD）+ OCR R9（A/B=R7 本周期复扫沿用 + C6=4f88d9b310..新 HEAD）。

## 附录（2026-10-24，R8-C5 证据后扩权，编排者）

R8-C5 全量扫（ocr/r8-chunkC-4f88d9b310-1dcee7a9d.md）对 scrub.ts 给出两条同族新证据，**T14 范围据此扩大**：

1. **未闭合引号卡死 lead（security medium）**：`mysql -u o'brien -phunter2`、`docker login -u a"b -p pass`——旧 lead 引号作普通字符通过会脱敏；新成对引号臂遇未闭合引号（自然语言撇号 can't/o'brien、被截断命令）无法推进→整条规则失配→泄漏。修法：两引号臂之后补单字符回退臂（如 `|"'"`）——成对仍整段吞、未闭合退回旧单字符读法。
2. **值臂词中引号段部分脱敏回归（security medium）**：`docker login -p a"b;c"` shell 中是单 argv 词；旧臂 `[^\s'"-]\S*` 整词脱敏；R2 新臂 `[^\s'";|&-][^\s;|&]*` 在词中 `;` 截断→`[REDACTED];c"`（密码尾存活+记录残缺）。修法：值臂改「裸字符+成对引号段」序列（如 `(?:"[^"]*"|'[^']*'|[^\s'";|&-])+`）——保留 R2 拒分隔符开头词的目标，恢复整词脱敏。同形状臂（mysql 附加式/sshpass/SSHPASS=/redis）全量核。**本附录取代 T14 节「值臂不动」边界**（该边界系 R7-C4 时证据；R8-C5 证明值臂本身对 BASE 回归）。

对抗例矩阵相应扩充（未闭合撇号、词中引号段、`-p;cmd` 分隔符开头零回退、既有全部语义）。RED 基线锚点两版对照（BASE=4f88d9b310、R2 前、R2 后）由实施 worker 落报告。
