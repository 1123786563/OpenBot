# Task Brief S03：MIME charset 与 HTML 引用

- **Task/AC**: S03 / A03。正式 Issue：[#492](https://github.com/1123786563/OpenBot/issues/492)（本地票 `docs/tickets/upstream-openbot-update/issues/up03.md`）。
- **owner_role**: backend_implementer（你）。
- **工作区**: `/Users/wuyongjun/trea/OpenBot/.worktrees/upstream-openbot-update`。不得 cd 主 checkout、不得 git stash/commit/push。

## 事实源

1. Spec §2 第 4–5 条：MIME 每个 part 先 transfer decoding 再按自己的 charset 解码；未知 charset 回落 UTF-8；plain text 不做 HTML entity 解码；HTML-only 正文去标签后只解一轮字符引用，不递归还原双层引用。
2. 上游参考（只读）：`evidence/upstream-sources/server/src/responsibilities/email.ts`。与本地 `server/src/responsibilities/email.ts` 的行为差异：
   - `decodeBody` 增加 charset 参数；base64/quoted-printable 解出的 bytes 经 `decodeBytes`（`TextDecoder(charset)`，未知 label 回落 utf8）。
   - charset 从 part 自己的 Content-Type 提取：`/charset="?([^";\s]+)"?/i.exec(type)`。
   - HTML-only 分支在去标签后增加单轮字符引用解码 `CHARACTER_REFERENCE`（十进制/十六进制/amp、lt、gt、quot、apos、nbsp；`&amp;lt;`→`&lt;`；代理区与越界码点原样保留）。
   - 上游还有 `getLogger`→`console.error` 的改动，**不移植**，保留本地 logger。
3. `extractEmailText(raw:string, depth?:number):string` 签名保持；multipart plain 优先与递归深度限制、SNS 签名/topic allowlist/发送人过滤/正文上限均不动。

## owned_files

- `server/src/responsibilities/email.ts`
- `server/tests/responsibility-triggers.test.ts`

## 要求（RED→GREEN→REFACTOR）

1. **RED**：(a) 每 part 独立 charset——同一 multipart 中 utf-8 与 iso-8859-1 part 各自正确解出（base64 与 quoted-printable 均覆盖；QP 的 iso-8859-1 `caf=E9` 应得 "café"）；(b) 未知 charset 回落 utf-8；(c) HTML-only：`AT&amp;T`→`AT&T`、`we&#8217;re`→`we’re`、hex 引用、`&nbsp;`；`&amp;lt;` 结果是 `&lt;`（只解一层）；(d) plain text part 的 `&amp;` 不改写；(e) multipart 仍优先 text/plain。
2. 先跑 suite 证明新用例失败，再按上游行为最小实现。
3. **V-N**：`E2E_UNIT_SCOPE=server bunx e2e run --config e2e.unit.config.ts server/tests/responsibility-triggers.test.ts`；SNS 签名/topic/过滤/正文大小断言不回退。
4. 以邮件输入到触发正文的公共 seam（extractEmailText 及触发路由 fixture）验证，不以内部 decoder 单测代替验收。

## 禁止

- 不改 `server/src/openmuse-mail/`（主动发信）；不修改其他文件/ledger/docs。

## 报告

`evidence/s03/implementer-report.md`：改动摘要、RED/GREEN 证据、覆盖的编码/引用矩阵、偏差。
