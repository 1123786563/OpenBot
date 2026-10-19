# [craft-C5] 批次核验报告 — #431（Craft Preview 域，最后一张）

工作区：`craft410`（HEAD `3ca32d49`）。DB `postgres://postgres:postgres@127.0.0.1:5564/craft`：本票全部核验走注入 fakes 的单元/集成套件与 typecheck，未触库，容器按要求保留未删。
跑法：ADR 0008 两层制——原生层 `bunx e2e run --config e2e.unit.config.ts <file>`，Bun 层 `bun test ./<file>`。
工作区并存前批未提交增量（#415 的 lib.sh/tls-pipeline.test.ts 线、#406 的 preview-origin/webapp-proxy 头契约线、C4 的 bun-suites driver 小修），本批**零写入、零改动**，未回退、未混淆；下述测试结果为工作区现状（含该增量）。

---

## #431 Craft 预览独立 Origin — 鉴权修复：preview pass 签名化 — **部分满足：T1/T2 SATISFIED（零改动）；T3 浏览器验收运行 + T4 生产准入为遗留缺口（BLOCKED-GAP，留专项）**

父级 meta 票（#358 修复计划执行），无标准 AC 段，按票面 T1–T4 任务清单逐条对照 main 现状与提交线证据。任务前情：C3 批已实证 #427（R08 不透明 token）由本票签名 pass 线等价覆盖，#427 状态不影响本票判定。

**提交线归属**（实证）：`b12a0840`（T1 合入版）与 `70924c42`（T2 合入版）均已 `git merge-base --is-ancestor` 于 origin/main 与本工作区 HEAD。票面引用的分支提交 93c450c1/22b491b3 是 squash 前形态，以 main 上两提交为准。

**T1 签名 pass 原语 — SATISFIED（零改动），`server/src/craft/preview-pass.ts` 五要点逐一实证**：
- [x] 形状 `v1.<b64url(userId)>.<b64url(HMAC)>`：`PREVIEW_PASS_VERSION="v1"`，issue 拼接 `v1.{userPart}.{macPart}`，`PREVIEW_PASS_COOKIE_SHAPE` 正则钉死 43 字符 MAC；
- [x] 部署密钥按 `craft-preview-pass` 用途域分离派生：`PASS_KEY_PURPOSE="craft-preview-pass"`，`passKey()`=HMAC(secret, purpose)——与 preview label/签名/凭据加密等同一 secret 的其他用途不可互换；
- [x] 常量时间比较：`timingSafeEqual(mac, passMac(...))`，两侧长度先验相等（MAC_BYTES=32 恒定，长度不符在上文拒绝）；
- [x] 严格解析：精确版本、base64url charset + `decodeStrict` round-trip、精确 32 字节 MAC、sessionId/userId/候选长度上限，解析失败一律 null；
- [x] 旧明文 Cookie 无兼容分支：模块头注释明文 "NO legacy shape is ever accepted"，非 `v1.` 三段形状 verify 恒 null（craft-preview-pass.test.ts 17 例含全部伪造形态实证）。

**T2 HTTP/HMR 共用 verifyPass + owner 复核 — SATISFIED（零改动），实证**：
- [x] 共用判定：`server/src/index.ts:5600` `verifyPass: craftPreviewOrigin.verifyPass` 注入 webapp-proxy deps——HTTP 门（preview-origin.ts:993 `this.verifyPass(sessionId, request)`）与 HMR 升级（webapp-proxy.ts `resolvePreviewWebappHmrUpgrade` 首行 `deps.verifyPass(...)`）跑同一函数，无法漂移；
- [x] 兑换签发绑定 userId：preview-origin.ts:968 `previewPass.issue(sessionId, redeemed.userId)`（票返回的 userId，非请求方自述）；
- [x] `(sessionId, verifiedUserId)` 复核会话行：HTTP 与 HMR 两侧均 `findSession(sessionId, verified.userId)`，owner 变更/会话删除 → 404（"a pass minted before a reassignment or restart-deletion dies here"）；
- [x] 拒绝矩阵：改 MAC（MAC 翻转）/跨会话 replay/跨密钥（不同 secret codec）由 pass.test 实证；owner 变更/删除会话 404 由 origin/proxy/hmr 套件实证；401 形状 `PREVIEW_PASS_REFUSAL`。

**验证命令（本工作区实证）**：
- 原生层 `bunx e2e run --config e2e.unit.config.ts server/tests/craft-preview-{pass,ticket,rejection,origin}.test.ts server/tests/craft-webapp-proxy.test.ts` → **5 files 264/264 passed**（pass 17 + ticket 24 + rejection 24 + origin 113 + proxy 86）；
- Bun 层 `bun test ./server/tests/craft-webapp-hmr.test.ts` → **39 pass / 0 fail**。注意：其余 5 文件属原生层（顶层 import `tests/support/e2e-compat`，其 `node:module#registerHooks` 在 Bun 下为致命加载错误，refusals.ts/bun-test-compat.ts 注释明示此分层为设计使然），`bun test` 直跑它们出现 5×unhandled-error 是跑错层，非缺陷；
- server typecheck `tsc --noEmit` → **exit 0**；
- 票面"6 文件 289/289"为修复分支时点快照；现行两层合计 303 例全绿，差额来自其后落 main 的增量（如 #406 头契约 4 例等），方向一致：零失败。

**T3 真实浏览器验收与 Server Actions 补证 — 部分完成（代码侧已进 main，运行侧 BLOCKED-GAP）**：
- 脚本交付物已提交进 main：`6b731c93`（10-17，`git merge-base --is-ancestor` 实证在 main）——新增伪造 cookie 双拒场景（无票 context 植入 `openbot_preview_session=<sessionId>`，HTTP 须 401、HMR upgrade 不得 commit）+ Server Actions 探针去 SKIP 改真断言（probe-action 点击须在结果区出 `action-ok-`，网络证据证明 next-action POST 打到本会话 preview origin）；
- 但该提交自述 "browser run currently BLOCKED — sandbox upstream regression"：真实浏览器验收**运行**未执行，票面 T3 未勾与仓库现状一致。缺口性质为运行态验收（需 sandbox 上游恢复 + 真浏览器环境），非代码缺口，本批零写入约束下不可也不应就地补。

**T4 生产准入、ACME staging 演练与 Spec 差异裁决（AC1–AC9 逐项证据表）— 未做，BLOCKED-GAP**：纯运维/准入性质（生产 ACME 演练、AC 证据表裁决），无代码可核、无测试可跑，属专项派发范围。与父票 #358 的既有遗留（AC8 DNS 缺口，见 C4 批记忆）同族。

**改动文件**（本会话）：无（零写入，仅本报告）。

**遗留（留专项）**：① T3 真实浏览器验收运行（前置：sandbox 上游回归恢复；脚本已就绪）；② T4 生产准入 + ACME staging 演练 + AC1–AC9 证据表。两者均为 #358 修复计划收尾的一部分，建议与母票 #358 的 AC8 DNS 缺口、R 系列修复票合并排期。
