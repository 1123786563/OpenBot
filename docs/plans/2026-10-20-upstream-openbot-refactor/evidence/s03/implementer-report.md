# S03 Implementer Report：邮件触发按正文编码与 HTML 字符读取内容（AC A03）

- 执行角色：backend_implementer；日期 2026-10-20。
- 工作区：`.worktrees/upstream-openbot-update`（分支 `upstream-openbot-update`，改动期间 HEAD = `3b4a7c68`）。未 commit、未 stash、未 push。`git status --short` 中 tracked 修改除本次 owned 两文件（`server/src/responsibilities/email.ts`、`server/tests/responsibility-triggers.test.ts`）外，仅有 S01/S02 已在场的 `server/src/config.ts`、`server/src/telemetry/scrub.ts`、`server/tests/config.test.ts`、`server/tests/enterprise-controls.test.ts`、`server/tests/otel-export-scrubbing.test.ts`（未触碰）。

## 改动摘要

| 文件 | 改动 |
| --- | --- |
| `server/src/responsibilities/email.ts` | +66/-11：新增 `decodeBytes(bytes, charset)`（`TextDecoder(charset)`，未知 label 捕获异常回落 `bytes.toString("utf8")`）；`decodeBody` 增加 `charset` 参数，base64 与 quoted-printable 两条路径的产物 bytes 改经 `decodeBytes` 解码；charset 从 part 自己的 Content-Type 提取（`/charset="?([^";\s]+)"?/i.exec(type)?.[1]`）；HTML-only 分支在去标签之后、空白折叠之前插入单轮 `CHARACTER_REFERENCE` 解码（十进制 `\d{1,7}` / 十六进制 `#x[0-9a-f]{1,6}` / `amp|lt|gt|quot|apos|nbsp`，代理区与 `code<=0`、`code>0x10ffff` 原样保留，未知命名保留原文）。`extractEmailText(raw, depth)` 签名未变；multipart plain 优先、递归深度 <5、SNS 签名验证、topic allowlist、发送人过滤、16 000 字符正文上限均未改动。 |
| `server/tests/responsibility-triggers.test.ts` | +88 行（纯插入，位于既有 `"MIME text extraction prefers text/plain"` 用例之后）：新增 6 个用例 + 2 个 multipart fixture（`perPartMime`、`latin1HtmlMime`），全部走 `extractEmailText` 公共 seam 或完整 SNS 签名路由。无既有断言修改或删除。 |

实现与上游参考 `evidence/upstream-sources/server/src/responsibilities/email.ts` 的 brief 列出差异逐条一致；上游 `getLogger`→`console.error` 改动按 brief 指示**未移植**，本地 logger（`getLogger("server")` + `log.error`）原样保留。

## RED（先失败）

命令（同验证命令）：

```
E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/responsibility-triggers.test.ts
```

首轮 RED 输出：**4 failed | 30 passed (34)**。失败用例恰为新增 6 用例中的 4 个：

1. `each part decodes with its own charset after transfer decoding` — 实得 `The disk on db-1 is at caf� level.`（QP iso-8859-1 `caf=E9` 被按 UTF-8 读成 U+FFFD）
2. `a base64 part decodes in its declared charset, not always UTF-8` — 实得 `caf� x&sol;y`（base64 iso-8859-1 同病）
3. `HTML-only bodies decode character references exactly once` — 实得 `AT&amp;T we&#8217;re &#x27;q&#x27; A&nbsp;B &amp;lt;tag&amp;gt; &#0; &#55296;`（引用未解码）
4. `a signed SES notification decodes each part in its own charset` — `events[0].payload.text` 实得 `caf� level.`（端到端 seam 同病）

补强 RED 证明：为覆盖「代理区/越界码点原样保留」，在用例 3 的 fixture 上追加 `&#0;`、`&#55296;` 后，曾把 `email.ts` 单文件还原到 BASE（`git checkout -- <file>`，未用 stash）复跑，该用例仍以完整期望串失败（`expected "…&amp;lt;tag&amp;gt; &#0; &#55296;" to be "AT&T …"`），随后恢复实现，证明新增断言在旧实现下真实失败。

两用例设计即为守卫、首轮即绿（如实记录，非 RED）：

- `a charset the runtime does not know falls back to UTF-8`（`charset=x-unknown-8bit` + base64 UTF-8）——回落行为新旧一致；其价值在实现后守护「未知 charset 不得抛错、不得误用 latin1」。
- `plain text bodies keep character references as written`——plain text 不做引用解码，新旧一致。

## GREEN（最小实现转绿）

实现后同一命令：**34 passed (34)**（含 format 修正后复跑，两轮均 34/34）。既有 28 个 SNS/触发用例（签名 v1/v2、topic 拒绝、证书 host 校验、allowedSenders、SubscriptionConfirmation、去重等）全部保持通过，无断言削弱。

## 编码 / 引用覆盖矩阵

| # | 输入形态 | 期望 | 证明方式 |
| --- | --- | --- | --- |
| E1 | multipart plain part `charset=iso-8859-1` + QP（`caf=E9`） | `café` | RED→GREEN（extractEmailText） |
| E2 | multipart plain 优先于 html（同 fixture 中 html part 为 utf-8 base64 `<b>disk</b>`，若误选 html 会得 `disk`） | plain 胜出 | E1 同 fixture + 既有用例双覆盖 |
| E3 | html-only part `charset=iso-8859-1` + base64 | `café x&sol;y` | RED→GREEN |
| E4 | `charset=x-unknown-8bit` + base64（UTF-8 bytes） | `café`（回落 UTF-8，不抛错） | 守卫用例（设计上两态皆绿） |
| E5 | `charset=utf-8` + QP（`99=25`，既有用例） | `99%` | 既有用例保持绿 |
| R1 | HTML `AT&amp;T` | `AT&T` | RED→GREEN |
| R2 | HTML `we&#8217;re`（十进制） | `we’re` | RED→GREEN |
| R3 | HTML `&#x27;q&#x27;`（十六进制） | `'q'` | RED→GREEN |
| R4 | HTML `A&nbsp;B` | `A B`（空格并入折叠） | RED→GREEN |
| R5 | HTML `&amp;lt;tag&amp;gt;` | `&lt;tag&gt;`（只解一层） | RED→GREEN |
| R6 | HTML `&#0;`、`&#55296;`（越界/代理区） | 原样保留 | RED→GREEN（补强 RED 见上） |
| R7 | HTML `&sol;`（命名表外） | 原样保留 | E3 同 fixture 断言 |
| R8 | plain text `&amp;`、`&lt;`、`&gt;`、`&amp;lt;` | 原样保留 | 守卫用例（两态皆绿） |
| S1 | 完整 SNS 签名通知 → 触发 payload | `payload.text` 为 `café` 版本 | RED→GREEN（路由级 seam） |

## 验证与格式自查

- `E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/responsibility-triggers.test.ts` → 34 passed (34)。
- `bunx biome format server/src/responsibilities/email.ts` → 真实 exit 0（"Checked 1 file … No fixes applied"）。
- `bunx biome format server/tests/responsibility-triggers.test.ts` → 真实 exit 0。期间曾发现一处本人新增代码的折行漂移（`Record<string, unknown>` 断言折行），已修正后复检 exit 0；BASE 既有行未触碰。
- 禁区确认：未改 `server/src/openmuse-mail/`；未改 owned_files 之外任何 tracked 文件；未改 ledger/docs（本报告为 brief 指定的任务产出）；fixture 全部使用虚构发件人与边界串。

## 偏差

- 无与已批准 Spec 的冲突。两点如实说明：
  1. 「未知 charset 回落 UTF-8」与「plain text 引用不改写」两条在新旧实现下行为本就一致，无法构造真实 RED，按守卫用例落地并在首轮 RED 输出中如实标注为通过项。
  2. 上游 `console.error` 改动按 brief 指示不移植，本地 `getLogger` logger 保留，故实现与上游参考文件在 logger 处存在**有意**差异。
