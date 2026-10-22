# S03 Independent Review：邮件触发按正文编码与 HTML 字符读取内容（AC A03，Issue #492）

- Reviewer：独立 reviewer（只读；唯一写入为本报告）。日期 2026-10-20。
- 工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`，HEAD = `3b4a7c68132c3507300408346a44fb9d56f3c14c`（与实施/验证时一致）。
- 审查范围：S03 两文件增量（`server/src/responsibilities/email.ts`、`server/tests/responsibility-triggers.test.ts`）。diff 中 `server/src/config.ts`、`server/src/telemetry/scrub.ts`、`server/tests/config.test.ts`、`server/tests/enterprise-controls.test.ts`、`server/tests/otel-export-scrubbing.test.ts` 为 S01/S02 已验收在场改动，不在本次范围。
- 质量关口定位：OCR 关卡已取消，本 Review 为 S03 最终质量关口。

## 独立复核记录（全部亲自执行）

| 项 | 命令/方法 | 结果 |
| --- | --- | --- |
| e2e 验收 | `E2E_UNIT_SCOPE=server E2E_UNIT_OUTPUT=.e2e/unit-s03-review bunx e2e run --config e2e.unit.config.ts server/tests/responsibility-triggers.test.ts` | **34 passed (34)，0 failed**，与两份报告一致 |
| 上游一致性 | `diff` 上游参考 vs 本地 `email.ts` | 仅两处差异：本地多 `getLogger` import + `const log`；`routes.onError` 用 `log.error({...}, "email-trigger-error")` 替代上游 `console.error(JSON.stringify(...))`。**即 brief 指示的唯一有意差异**；`decodeBytes`/`decodeBody`/`CHARACTER_REFERENCE`/`NAMED_CHARACTERS`/`decodeCharacterReference`/`extractEmailText` 逐字节一致 |
| 证据绑定 | `git diff --` 两文件 分段 vs `after-tracked.diff` | `EMAIL.DIFF == EVIDENCE`、`TEST.DIFF == EVIDENCE`，逐字一致 |
| numstat | `git diff --numstat` | email.ts **73/11**、test **88/0**（见 F1 报告口径） |
| 纯插入验证 | test diff 删除行计数；`test(` 计数 HEAD vs 当前 | 删除行 = **0**；HEAD 28 个 test → 当前 **34**（+6），既有 28 用例零削弱 |
| 行为抽查 | `bun --eval` import 当前 `extractEmailText`，8 组独立 fixture（T1–T8） | T1 QP iso-8859-1 `caf=E9`→`café` 且 plain 胜出（html 为 `<b>disk</b>`，误选会得 `disk`）；T2 base64 iso-8859-1 html + `&sol;` 保留；T3 base64 iso-8859-1 plain 隔离验证；T4 `x-unknown-8bit` 回落 UTF-8 不抛错；T5 `AT&amp;T`→`AT&T`、`&#8217;`→`’`、`&#x27;`→`'`、`&nbsp;`→空格、`&amp;lt;tag&amp;gt;`→`&lt;tag&gt;`（单层）、`&#0;`/`&#55296;`/`&#1114112;` 原样、`&amp;amp;`→`&amp;`（单层）；T6 plain 引用原样；T7 `&#X3C;`/`&AMP;`/`&NBSP;` 大小写变体解码（见 F4）；T8 无 charset 声明回落 UTF-8 |
| RED 真实性 | 从 after-tracked.diff 提取被删除的 BASE `decodeBody`+`stripHtml` 独立重放（R1–R4） | R1 QP latin1 → `"The disk on db-1 is at caf� level."`；R2 base64 latin1 html → `"caf� x&sol;y"`；R3 html 引用原样 `AT&amp;T we&#8217;re`；R4 既有 `99=25`→`99%` 在 BASE 下通过（排除运行器差异）。四条失败输出与实施报告 RED 实得**逐字一致**；守卫两用例（未知 charset 回落、plain 不改写）在 BASE 下确实通过，属新旧一致，无法构造真实 RED，报告披露诚实 |
| multipart 不变量 | S03 diff 中 grep `depth|multipart|boundary|text\/plain` 变更行 | **无任何 +/- 行**触碰 plain 优先与 `depth < 5` 块（纯上下文） |
| 防回退项 | 源码核对 + diff hunk 范围（email.ts 仅 `@@ -159,21` 与 `@@ -201,11` 两 hunk） | SNS 签名（RSA-SHA1/256、证书 host 白名单）、topic allowlist、发送人过滤、`bodyLimit` 300 KiB、`slice(0, 16_000)` 正文上限全部原样；`server/src/openmuse-mail/` diff 为空 |
| format | `bunx biome format` 两文件 | exit 0，"No fixes applied" |
| lint | `bunx biome lint --error-on-warnings` 两文件 | exit 0 |
| seam 结构 | 测试源码核对 | 5 个新用例走 `extractEmailText` 公共 seam；第 6 个走 `harness()`+`signed()`（真实 RSA `createSign` + `createSnsVerifier` + 真实 fixture 证书）断言 `events[0].payload.text`；无内部 decoder 单测 |
| 类型检查 | `bunx tsc --noEmit`（server） | 仅 `scripts/bootstrap-local-gateway.ts` 3 个**既有**错误（该文件本分支 0 改动，非 S03 引入；见 F3） |

## Spec compliance 逐条核对（Spec §2 第 4–5 条 / up03 AC）

| AC / Spec 条目 | 证据 | 结论 |
| --- | --- | --- |
| 每 part 先 transfer decoding 再按自己 charset 解码；base64 与 QP 均覆盖 | `decodeBody(body, encoding, charset)`：base64 与 QP 两条路径产物 bytes 均经 `decodeBytes`；charset 取自递归后该 part 自己的 Content-Type（email.ts:261–265）；T1/T3 双编码双验证；T8 无声明回落 | 满足 |
| 未知 charset 回落 UTF-8；multipart 维持 plain 优先与递归深度限制 | `decodeBytes` 捕获 TextDecoder label 异常回落 `bytes.toString("utf8")`（T4）；multipart 块纯上下文零改动 | 满足 |
| HTML 引用 named/decimal/hex/nbsp；双层只解一层；plain 不做 HTML 解码 | `CHARACTER_REFERENCE` 单轮 replace 且仅在 `/^text\/html/` 分支、去标签之后（email.ts:270）；T5 全矩阵 + `&amp;lt;`→`&lt;` 单层实证；T6 plain 原样 | 满足 |
| SNS 签名/topic allowlist/发送人过滤/正文上限保持 | 两 hunk 范围核对 + 端到端签名用例（含 v1/v2、topic 拒绝、host 校验、allowedSenders 既有用例）全绿 | 满足 |
| 以邮件输入到触发正文的公共 seam 验证 | `extractEmailText` 5 用例 + 完整 SNS 签名路由 1 用例，无内部 decoder 单测 | 满足 |
| 不改 OpenMuse 邮件 BFF / 主动发送 | `git diff --name-only -- server/src/openmuse-mail/` 为空 | 满足 |

## Findings

无 Blocker / Major / Minor。以下均为 Low / Info 级。

- **F1（Low，报告数字口径，不处理）**：实施报告称 email.ts “+66/-11”；`git diff --numstat` 实为 **+73/-11**（测试 +88 正确）。净行为与代码事实不受影响，validator 以 diffstat 口径（84 变更行标记）自洽。仅报告计数偏差，登记备查。
- **F2（Low，既有漂移，非本次引入，不处理）**：`bunx biome check` 对两文件各报 1 处 `assist/source/organizeImports`（email.ts:26 `const log` 前缺空行；test 文件首行 import 排序）。逐字节核对 HEAD 原文件：两处**原样存在于 HEAD**，S03 diff 未触碰任何 import 行；仓库实际门禁 `biome format` 与 `biome lint --error-on-warnings` 均对两文件 exit 0。与 S02 Review F4 同类，归属 V01 既有漂移统一登记。
- **F3（Info，范围外既有问题）**：`tsc --noEmit` 在 `server/scripts/bootstrap-local-gateway.ts` 有 3 个既有类型错误；该文件本分支零改动，不属 S03 范围，仅记录避免误读 typecheck 全绿。
- **F4（Info，上游继承行为）**：`gi` 标志 + `name.toLowerCase()` 使 `&#X3C;`、`&AMP;`、`&NBSP;` 等大小写变体同样解码。与上游逐字一致，且 HTML5 命名引用本就含部分大写变体，无风险。
- **F5（Info，上游继承边界）**：单引号 charset 值（`charset='iso-8859-1'`）会把引号一并捕获，TextDecoder 抛错后回落 UTF-8。仅非标准邮件输入受影响，与上游行为一致，不应本地分叉。
- **F6（Info，覆盖边界记录）**：测试无显式断言 multipart 递归深度限制（`depth < 5`）。该逻辑在 S03 diff 中为纯上下文零改动，AC 的“维持”以不改写成立；属既有覆盖缺口而非本次回归，留待后续上游同步时补充。
- **守卫用例判断（任务第 3 项要求）**：可接受。两守卫用例（未知 charset 回落、plain text 不改写）经 BASE 逻辑独立重放确认新旧行为确实一致，真实 RED 不可能构造；实施者如实标注为非 RED 并以 BASE 复跑补强其余 4 用例的 RED 证据（R1–R3 输出逐字吻合），处理诚实且符合证据标准。

## 结论摘要

- 实现与上游参考逐字节一致，唯一差异（`getLogger`/`log.error` 保留）恰为 brief 指示的**不移植项**；上游 `console.error` 无残留。
- 五条 AC 全部以公共 seam 证据满足；multipart 不变量与 SNS 防回退项经 diff hunk 范围核对零改动，34/34 全绿。
- 报告声明抽查全部属实（除 F1 行数口径）；证据 diff 与工作树逐字绑定；RED 真实性经 BASE 重放独立确认。
- 发现均为 Low/Info 级，无需整改即可通过；F1/F2 记入报告口径与既有漂移台账。

Spec compliance: pass
Code quality: pass
