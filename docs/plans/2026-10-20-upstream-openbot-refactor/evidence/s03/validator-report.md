# S03 Validator Report（backend_validator，2026-10-20）

- 对象：Task S03 邮件触发按正文编码与 HTML 字符读取内容（AC A03，Issue #492）。
- 工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`，HEAD = `3b4a7c68`（与实现者报告一致）。
- 方法：只读源码与测试；亲自运行验证命令；用 `bun --eval` 独立 import 当前 `extractEmailText` 复核行为；用 diff 中被删除的 BASE `decodeBody` 逻辑独立复现旧行为以核对 RED 真实性。未修改任何源码/测试/文档，未 commit/stash/push。

## 结论：**PASS**（5/5 项通过，0 项 FAIL；2 条 Low 级观察，不阻塞）

## 逐项验收

### 1. 行为与关键用例抽查 — PASS

亲自运行：

```
E2E_UNIT_SCOPE=server E2E_UNIT_OUTPUT=.e2e/unit-s03-validator bunx e2e run --config e2e.unit.config.ts server/tests/responsibility-triggers.test.ts
```

结果：**Test Files 1 passed (1)，Tests 34 passed (34)**（与报告 GREEN 数字一致）。

独立抽查（`bun --eval` 直接 import `server/src/responsibilities/email.ts` 的 `extractEmailText`，不经测试文件）：

| 抽查 | 输入 | 实得 | 结论 |
| --- | --- | --- | --- |
| 同一 multipart，plain QP iso-8859-1 `caf=E9` + html base64 utf-8 | `perPartMime` fixture | `"The disk on db-1 is at café level."` | `caf=E9`→`café` 正确，且 plain 胜出（html 是 `<b>disk</b>`，误选会得 `disk`） |
| base64 iso-8859-1 html | `PHA+Y2Fm6Twv...` | `"café x&sol;y"` | charset 正确；`&sol;` 表外命名保留 |
| base64 iso-8859-1 plain（隔离 charset 因素） | `Y2Fm6Q==` | `"café"` | 同上 |
| 未知 charset `x-unknown-8bit` + base64 utf-8 bytes | `Y2Fmw6k=` | `"café"` | 回落 UTF-8，不抛错 |

### 2. HTML 引用矩阵 — PASS

对 html-only fixture（`bun --eval` 独立复核 + 测试 `HTML-only bodies decode character references exactly once` 双证）：

- `AT&amp;T` → `AT&T`：PASS
- `we&#8217;re` → `we’re`（十进制）：PASS
- `&#x27;q&#x27;` → `'q'`（十六进制）：PASS
- `A&nbsp;B` → `A B`：PASS
- `&amp;lt;tag&amp;gt;` → `&lt;tag&gt;`（单层，不递归）：PASS
- `&#0;`、`&#55296;`（越界/代理区）→ 原样保留：PASS
- `&sol;`（表外命名）→ 原样保留：PASS
- **plain text 的 `&amp;` 不改写**：`plain text bodies keep character references as written` 断言 `"Contact AT&amp;T about &lt;tag&gt; and &amp;lt;b&amp;gt;."` 原样输出，独立复核一致：PASS

### 3. seam 与结构 — PASS

- 用例覆盖两级公共 seam：`extractEmailText`（5 个新用例）+ 完整 SNS 签名路由（`a signed SES notification decodes each part in its own charset` 走 `harness()` + `signed()` 真实 RSA 签名 + `createSnsVerifier`，断言 `events[0].payload.text`）。没有只测内部 decoder 的用例。
- 签名未变：`export function extractEmailText(raw: string, depth = 0): string`（email.ts:235）。
- multipart plain 优先与 `depth < 5` 递归限制未动：diff 中该块纯上下文，无改动行。
- 测试 diff 为纯插入：`git diff` 删除行计数 = 0；28 个既有用例（签名 v1/v2、topic 拒绝、证书 host、allowedSenders、SubscriptionConfirmation、去重等）在 34/34 中全部保持通过，零削弱。
- email.ts 的删除行仅限旧 `decodeBody`（utf8 硬编码路径），SNS 验证/topic allowlist/发送人过滤/`bodyLimit` 300KiB/16_000 字符上限代码全部原样在文件中。
- 上游 `console.error` 改动未移植：上游参考 `onError` 用 `console.error(JSON.stringify(...))` 并删除 logger import；本地保留 `getLogger("server")` + `log.error`（email.ts:23-26、330-338），与 brief 第 14 行指示一致，属有意差异。

### 4. 范围 — PASS

- tracked 改动共 7 文件：S03 owned 两文件（`server/src/responsibilities/email.ts` +84 行、`server/tests/responsibility-triggers.test.ts` +88 行）+ S01/S02 已各自验收的 5 文件（`config.ts`、`scrub.ts`、`config.test.ts`、`enterprise-controls.test.ts`、`otel-export-scrubbing.test.ts`，本次未触碰）。
- 证据 diff 与当前工作树逐字一致：`git diff -- <两文件>` 与 `after-tracked.diff` 对应段落 `diff` 为空（EMAIL.DIFF == EVIDENCE、TEST.DIFF == EVIDENCE）。
- `server/src/openmuse-mail/`：`git diff --name-only HEAD -- server/src/openmuse-mail/` 为空，未触碰。
- untracked 仅为 plan/spec/ticket/evidence 文档，非源码。

### 5. RED 真实性 — PASS

- 数字自洽：文件共 34 个 `test(`，HEAD 处为 28 个，新增 6 个 → 34；RED 报告 4 failed | 30 passed (34) = 28 既有 + 2 守卫用例通过、4 新用例失败，账目吻合。
- 失败逻辑复现：把 diff 中被删除的 BASE `decodeBody` 原样重放——`caf=E9`（QP iso-8859-1）→ `"The disk on db-1 is at caf� level."`、base64 latin1 html → `"<p>caf�</p><p>x&sol;y</p>"`，与报告 RED 实得（`caf� level.`、`caf� x&sol;y`）逐字一致；BASE html 分支无引用解码，`AT&amp;T` 等保持原样，第 4 用例必败；端到端用例同 charset 病因必败。既有 `99=25`→`99%` 在 BASE 下也通过（说明非运行器差异）。
- 两条如实标注的非 RED 守卫用例（未知 charset 回落、plain text 不改写）经独立复核确属新旧行为一致，无法构造真实 RED，报告披露诚实。
- 无残留半成品：email.ts 无 `console.error`/TODO/FIXME 残留；`bunx biome format` 对两文件 exit 0（"No fixes applied"）；`extractEmailText` 无其他消费方（grep 仅 owned 两文件），无连带漂移。

## 问题分级

- **Blocker：无。**
- **Major：无。**
- **Minor：无。**
- **Low（观察，不阻塞）：**
  1. `decodeCharacterReference` 按上游对**越界但非代理区**码点（如 `&#1114112;`，> 0x10FFFF）返回原文，正确；`&#0;` 由 `code > 0` 排除，行为与上游一致。仅提示：该正则 `\d{1,7}` 上限 9 999 999，超长数字引用整段不匹配而保留原文，同样安全。无需改动。
  2. 未知 charset 回落与 plain text 不改写两用例为守卫性（新旧皆绿），报告已如实披露并以 BASE 复跑补强其余 4 用例的 RED 证据，处理得当。

## 验证命令与产物

- `E2E_UNIT_SCOPE=server E2E_UNIT_OUTPUT=.e2e/unit-s03-validator bunx e2e run --config e2e.unit.config.ts server/tests/responsibility-triggers.test.ts` → 34 passed (34)
- `bunx biome format server/src/responsibilities/email.ts server/tests/responsibility-triggers.test.ts` → exit 0
- `git diff`（email.ts、responsibility-triggers.test.ts）与 `evidence/s03/after-tracked.diff` 逐字比对一致
- `bun --eval` 独立行为抽查 6 组（T1–T6）与 BASE 逻辑重放 3 组，输出见上文

## 相关文件

- 实现：`server/src/responsibilities/email.ts`
- 测试：`server/tests/responsibility-triggers.test.ts`（新增 6 用例 + `perPartMime`/`latin1HtmlMime` fixtures，位于 `"MIME text extraction prefers text/plain"` 用例之后）
- 证据：`docs/plans/2026-10-20-upstream-openbot-refactor/evidence/s03/{brief.md,implementer-report.md,after-tracked.diff}`
- 上游对照：`docs/plans/2026-10-20-upstream-openbot-refactor/evidence/upstream-sources/server/src/responsibilities/email.ts`
