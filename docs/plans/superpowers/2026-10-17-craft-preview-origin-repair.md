# Craft Preview Origin 鉴权加固与验收补证 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 preview 会话 Cookie 可由已知 session id 伪造的鉴权旁路，并使 #358 的剩余验收结论对应同一已验证代码版本。

**Architecture:** 保留已合并的 Host 路由、30 秒一次性 ticket、现有 dev server 附着模型和旧会话双轨。兑换后改发由部署密钥签名、绑定 sessionId 与 userId 的会话级 preview pass；HTTP 与 HMR 使用同一验证接缝，并在读到会话行后核对当前 owner。随后以真实浏览器和非生产 TLS 演练补齐运行证据，按批准 Spec 记录实现差异。

**Tech Stack:** Bun、Hono、Node crypto、Next.js 16、React、Playwright、acme.sh / ACME DNS-01。

**Spec:** `docs/specs/2026-10-15-craft-preview-origin-design.md`；GitHub #358 及实施关联 #359–#367。原实施计划：`docs/plans/superpowers/2026-10-15-craft-preview-origin-execution.md`。

## Global Constraints

- 本计划基线为 `origin/main@44754feb4bd89d33aa7d3947ac77a7eb0949ee00`。上次审核的本地 `main@ce1d9ce` 比该基线旧，不能把旧 HEAD 的“未实现”结论当作新开发清单。执行前重新记录分支、HEAD 和 diff。
- #358 的 GitHub **正式子 Issue 为 0**；#359–#367 是正文关联的实施票据，`contains` 与票面 `Blocked by` 分开记录。
- D1/D3/D7：生产每会话 hash 子域名，hostname 不含可直接解码的 session id；D4/D9：ticket 单次使用、TTL **30 秒**，兑换后 Cookie 为 **HttpOnly、无 Max-Age/Expires**；D10：旧会话不迁移；D11：新会话 `webapp_url` 是绝对地址。
- preview pass 是凭据，不能由 session id、hostname 或公开数据独自构造；不得写入日志、错误响应或 URL。旧明文 session-id Cookie 必须被拒，不能保留兼容旁路。
- 保持 `SameSite=None; Secure`、生产 Cookie `Path=/`、dev Cookie `Path=/<label>`；不能把 preview Cookie 转发给生成应用。浏览器关闭后客户端 Cookie 消失，不增加空闲超时。
- HTTP 与 HMR 在升级提交前采用同一 pass 和 owner 判断；未知 Host、未知会话、准入关闭、无效票据继续分别返回既有 404/503/401 语义。
- `webapp tool` status/logs/restart 与预览继续指向同一个 dev server。旧会话同源路径只按 D10 保留，不向新会话静默回退。
- 本次用户只要求计划；此文件不授权实现、提交、推送、部署或修改 Issue。以后执行时按仓库规则使用隔离工作区、SDD、独立 Review 与 OCR；没有单独提交授权时采用未提交检查点。

## 已核实的基线事实与修复边界

- PR #400/#401 已在该基线中；`preview-origin.ts`、`preview-ticket.ts`、`webapp-generation.ts`、证书 sidecar 和验收脚本均存在。针对性 `bun test server/tests/craft-preview-ticket.test.ts server/tests/craft-preview-origin.test.ts server/tests/craft-preview-rejection.test.ts` 为 **140 pass / 0 fail**，但没有测试伪造 pass。
- `preview-origin.ts` 兑换时把 `sessionId` 原文传给 `previewSessionCookieHeader`；`holdsPreviewSessionPass` 仅比较 Cookie 值与 sessionId。`resolvePreviewWebappHmrUpgrade` 复用此判断，HTTP 的 `createPreviewProxy` 和 HMR 均随后按 id 查会话。最小复现：`holdsPreviewSessionPass("cs_demo", Request{Cookie: openbot_preview_session=cs_demo}) === true`，未签票、未兑换。已知预览地址及 session id 的请求可绕过 AC4 的票据入口；这不证明攻击者能枚举未知的 hash 主机。
- `scripts/craft-preview-acceptance.ts` 明确将 **Server Actions 协议级断言标为 SKIP**；四种写方法和页面热更新不能替代这项 AC2 证据。
- 生产 ACME 代码与脚本已有，但本计划基线没有真实 DNS 凭据或生产运行证据。证书首签、续期和告警结果只能通过授权的非生产演练及后续部署证据确认。
- `reference/craft-preview-origin.md` 已记录内存 registry 重启空窗与 Safari 明文 loopback 限制；二者是已接受/已披露边界，不在没有新需求的情况下擅自重构。

**执行期临时收敛：** 若目标部署当前运行这版明文 pass，修复交付前应由有部署权限的人把 `OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED=false` 作为临时门控，并核验新会话的 `webapp-info` 显示关闭原因、预览请求为 503 且不回退旧同源路径；旧会话仍按 D10 单独评估。本计划不执行该配置变更。

## File Structure

| 文件 | 单一职责 |
|---|---|
| `server/src/craft/preview-pass.ts`（新） | 版本化签名 pass 的签发与校验；使用部署密钥的独立用途派生 key、常量时间 MAC 比较。 |
| `server/src/craft/preview-origin.ts` | 票据兑换后发 pass；HTTP 请求调用同一 pass 校验并把已认证 userId 传给代理。 |
| `server/src/craft/webapp-proxy.ts` | HTTP/HMR 在查到 session 后核对 owner，拒绝旧明文 Cookie 与无效签名。 |
| `server/src/index.ts` | 把同一 pass 校验接缝注入 HMR 与 HTTP，不创建第二套判断。 |
| `server/src/craft/preview-ticket.ts` | 仅调整 `Set-Cookie` 的凭据值白名单，保留 ticket TTL、兑换和 Cookie 属性。 |
| `server/tests/craft-preview-pass.test.ts`（新） | 伪造、篡改、跨会话、跨用户、密钥轮换与旧 Cookie 拒绝。 |
| `server/tests/craft-preview-origin.test.ts`、`server/tests/craft-webapp-hmr.test.ts`、`server/tests/craft-preview-rejection.test.ts` | HTTP/WS 入口及浏览器 Cookie 路径回归。 |
| `scripts/craft-preview-acceptance.ts` | 真实生成应用的 Server Action、伪造 pass、浏览器隔离及重启检查。 |
| `reference/craft-preview-origin.md`、`reference/tls-certs.md` | 记录 pass 迁移、部署证据和已批准边界；不把计划当验收证据。 |

## Review Focus

以下五类输入的测试分别放在 Task 1–3，审查时重点检查：

1. 已知 session id 和 preview 地址、但没有兑换票据：手写明文 Cookie 必须 401（Task 1/2）。
2. 有效 pass 被改一字节、换 session 或换部署密钥：HTTP 与 HMR 都必须在转发/升级前拒绝（Task 1/2）。
3. 会话在 pass 签发后转给另一用户或删除：旧 pass 必须失效（Task 2）。
4. 同一浏览器并开两个 dev 预览：`/<label>` Cookie 并存，A/B 的 API 与 HMR 均可用且互不可用（Task 2/3）。
5. 升级时浏览器仍持有旧明文 Cookie：展示可重新进入的拒绝状态；主站重新换票后恢复，不允许旧 Cookie 兜底（Task 2/3）。

## DAG 与验收映射

| ID / 来源 | 验收 | depends_on | owner_role / validator_role | owned_files | 接口与验证 | 状态 |
|---|---|---|---|---|---|---|
| T1 / #358 AC4、#360、#366 | pass 不可伪造，旧值拒绝 | 无 | backend_implementer / backend_validator | `preview-pass.ts`、`preview-ticket.ts`、`craft-preview-pass.test.ts` | 产出 `PreviewPassCodec`；单测 | pending |
| T2 / #358 AC3/AC4/AC5、#361–#363、#366 | HTTP/HMR 同源校验、owner 变更拒绝 | T1 | backend_implementer / backend_validator | `preview-origin.ts`、`webapp-proxy.ts`、`index.ts`、相关 server tests | 消费 `PreviewPassCodec`；路由/WS 测试 | pending |
| T3 / #358 AC1/AC2/AC3/AC5/AC7/AC9、#362–#367 | 当前 HEAD 的真实浏览器全链；Server Actions 不再 SKIP | T2 | frontend_implementer / frontend_validator | `scripts/craft-preview-acceptance.ts`、必要的浏览器探针 | 消费 T2 的 pass；Playwright + 真实 dev server | pending |
| T4 / #358 AC6/AC8、#359；D6/D11 | 非生产证书演练、生产准入证据、Spec 差异裁决 | T2、T3 | backend_implementer / backend_validator | `reference/craft-preview-origin.md`、`reference/tls-certs.md`；仅确有失败时涉及证书脚本 | 消费 T3 证据；TLS 测试、DNS-01 staging 演练 | pending |

显式票据依赖仍为 `#360 → #361 → #362 → (#363,#364) → #365 → (#366,#367)`；本修复 DAG 只处理已集成基线上的新缺口，不重派九张原票。

### Task 1: 签名 preview pass 原语

**Files:** Create `server/src/craft/preview-pass.ts`, `server/tests/craft-preview-pass.test.ts`; Modify `server/src/craft/preview-ticket.ts` 的 Cookie 值白名单。

**Interfaces:** Produces `createPreviewPassCodec(secret: string): PreviewPassCodec`，其中 `issue(sessionId: string, userId: string): string` 返回版本化、URL/Cookie 安全的签名值，`verify(sessionId: string, candidate: string): { userId: string } | null`。格式定为 `v1.<base64url(userId)>.<base64url(mac)>`；MAC 对版本、sessionId 与 userId 的带长度或分隔编码签名，key 用 `craft-preview-pass` 用途从现有部署密钥派生。`verify` 严格限制长度/编码，使用常量时间比较。Cookie header 允许这个格式，最大长度明确覆盖当前 userId 形状；错误值折为空凭据。

- [ ] **Step 1: 写失败测试。** `craft-preview-pass.test.ts` 断言：明文 `cs_demo`、无票自造值、版本错误、MAC 改一字节、别的 session、别的 key 都返回 null；正确 `(sessionId,userId)` 返回该 userId；签名不含可从 sessionId 单独推导的值；Cookie header 仍为 HttpOnly、SameSite=None、Secure、无 Max-Age/Expires。
- [ ] **Step 2: 跑 RED。** `bun test server/tests/craft-preview-pass.test.ts`；预期因模块/接口不存在而失败。
- [ ] **Step 3: 实现最小 codec 与白名单。** 不改 `PREVIEW_TICKET_TTL_MS=30_000` 或一次性 ticket Map。任何旧明文 pass 均不进入兼容分支。
- [ ] **Step 4: 跑 GREEN。** 同一测试文件全通过；`bun run --filter server typecheck` 退出 0。若签名编码或类型检查失败，先修本任务，不能放行 T2。
- [ ] **Step 5: 保存任务检查点与独立 Review Package。** 记录文件 hash、测试结果；实现者不自行批准。

### Task 2: HTTP 与 HMR 共用签名 pass 和会话 owner 校验

**Files:** Modify `server/src/craft/preview-origin.ts`, `server/src/craft/webapp-proxy.ts`, `server/src/index.ts`, `server/tests/craft-preview-origin.test.ts`, `server/tests/craft-webapp-hmr.test.ts`, `server/tests/craft-preview-rejection.test.ts`。

**Interfaces:** Consumes T1 的 `PreviewPassCodec`。`PreviewOrigin.verifyPass(sessionId: string, request: Request): { userId: string } | null` 遍历当前同名 Cookie 候选并只接受有效签名；`ServePreview` 输入增加 `userId: string`。HTTP 代理按 `(sessionId,userId)` 找行；HMR resolver 的 deps 注入同一 `verifyPass`，升级前按 `(sessionId,userId)` 找行。兑换使用 ticket 返回的 `userId` 调 `issue`，不再把原始 sessionId 当 pass。

- [ ] **Step 1: 写失败入口测试。** 对已注册 Host 直接发送 `Cookie: openbot_preview_session=<sessionId>`：GET/POST 401、上游 fetch 次数 0；HMR 返回 401、`server.upgrade` 次数 0。有效票兑换得新 pass 后 GET/POST 与 HMR 成功。改 MAC、换 Host/会话、删除会话、改变 owner 均拒绝。两个 dev `/<label>` Cookie 同时存在时各自可用、交叉不可用。
- [ ] **Step 2: 跑 RED。** `bun test server/tests/craft-preview-origin.test.ts server/tests/craft-webapp-hmr.test.ts server/tests/craft-preview-rejection.test.ts`；新增伪造测试必须先失败，且失败点为被错误放行。
- [ ] **Step 3: 将 codec 实例接入 `createPreviewOrigin`，HTTP/HMR 复用 `verifyPass`。** owner 从签名 claim 取得并交由 store 的 `findSession(sessionId,userId)` 复核；无行返回 404，坏 pass 先返回 401。保持现有 Host、Origin、准入与 Cookie Path 判定。
- [ ] **Step 4: 跑 GREEN 与回归。** 上述三文件、`craft-preview-ticket.test.ts`、`craft-webapp-proxy.test.ts` 全通过；`bun run --filter server typecheck` 退出 0。旧明文 Cookie 必须 401，而重新换票须恢复。
- [ ] **Step 5: 更新 `reference/craft-preview-origin.md` 的升级说明。** 明确部署后旧 preview pass 被拒，用户从主站重新进入；不要求迁移旧会话 webapp 代际。保存检查点并由独立 reviewer 审 Spec 与代码质量。

### Task 3: 真实浏览器验收与 Server Actions 补证

**Files:** Modify `scripts/craft-preview-acceptance.ts`；仅在真实测试暴露产品缺陷时另起对应修复任务，不在本测试任务内顺手改业务代码。

**Interfaces:** 消费 T2 的签名 pass。现有 `installProbeApp` 已写入 `outputs/web/app/actions.ts` 的 `ping()` 与页面的 `probe-action` 按钮；本任务点击该按钮，断言 `probe-action-result` 出现 `action-ok-`，并在服务端/网络记录中确认请求确实到达本会话的 Next.js Server Action。原 `SKIP` 行改为 `PASS/FAIL`，不以 hydration 代替 action。

- [ ] **Step 1: 给验收脚本增加失败断言。** 在全新浏览器 context 中、没有票据时种入值为 session id 的伪造 Cookie，预览 HTTP 与 HMR 都拒绝；合法兑换后自身 GET 与四种写方法到达 handler、现有 `probe-action` 点击后 `probe-action-result` 改变；会话 A 不可读 B；主站 API 无会话响应；Cookie/storage 隔离；`webapp tool` status/logs/restart 与预览仍附着同一端口及进程；HMR 帧与热更新、全屏状态保持；旧会话走旧路径且有提示。
- [ ] **Step 2: 在可复现的本地 Chromium + Casdoor + sandbox dev server 栈运行脚本。** 预期 `FAIL=0` 且 Server Actions 项不是 `SKIP`；记录完整命令、基线 SHA、截图和脱敏网络日志。若环境缺失则记 `blocked`，不得把历史 run6 当本 SHA 的通过证据。
- [ ] **Step 3: 覆盖新旧会话和重启窗口。** 新会话重新换票恢复；旧会话按 D10 继续旧路径；明确记录 registry 重启后的 404/重新进入行为，不把已接受边界误报为新缺陷。
- [ ] **Step 4: 独立前端行为复核。** 验证 iframe 真正运行在独立 Host；下载、Tauri 与分享链路若不消费 `webapp_url`，留下搜索路径和运行证据；若消费，测试绝对地址处理。

### Task 4: 生产准入、ACME 演练与需求差异裁决

**Files:** Modify `reference/tls-certs.md`, `reference/craft-preview-origin.md`；仅在演练证明流水线缺陷时另立最小脚本修复任务，所有修复仍走 SDD/OCR。

**Interfaces:** 消费 T2/T3 的安全与浏览器证据；产出 AC1–AC9 逐项证据表，含 SHA、命令、结果、证据类型和未测范围。

- [ ] **Step 1: 跑不依赖真实凭据的 TLS 检查。** `bun test scripts/tls-pipeline.test.ts` 与 compose 配置校验，确认缺域名/证书时 `webapp-info` 有可展示关闭原因、preview Host 503 且没有同源回退。
- [ ] **Step 2: 在授权的 staging DNS zone 演练 AC8。** 用专用低权限 secret 完成首次 DNS-01 签发、自动加载、一次受控续期失败与告警恢复；只保存脱敏状态、时间戳、证书 SAN/到期日、告警事件，不读取或操作生产凭据。没有 staging 条件则 AC8 的运行结果保持 `blocked`，代码/流水线与实际签发分列。
- [ ] **Step 3: 提出两条精确 Spec 裁决供批准。** D6 建议表述为“生产 hash Host 在根路径，dev 默认 `127.0.0.1/<label>` 由显式 env 挂载，禁止 cwd 猜测”；AC1 建议区分“浏览器受 CSP 拦截或得到未认证响应”与“服务端协议层对应请求为 401”。批准前不得把与现有原文不一致的结果标为 `verified`。
- [ ] **Step 4: 完成验证总表与最终 Review/OCR。** 对本修复从执行 BASE 到 HEAD 及全部未提交交付内容审查；有效 critical/high/medium 清零。结果按 `verified/partial/not implemented/blocked/unknown` 标注，不以 Issue、PR 或旧测试记录代替当前 SHA 证据。

## 执行前自查

- AC1–AC9：T1/T2 封住 AC3/AC4/AC5 鉴权旁路；T3 补 AC1/AC2/AC3/AC5/AC7/AC9 运行证据；T4 补 AC6/AC8 与 D6/D11 裁决。没有把已存在的 #359–#367 代码重做一遍。
- 接口：T1 `verify → {userId}|null`；T2 HTTP/WS 使用同一值，数据库再校验 owner；T3 消费 T2 而不自造鉴权规则。Cookie 格式改变后必须同步更新所有测试夹具与脚本中的 Cookie 断言。
- 共享文件：T1 与 T2 对 `preview-ticket.ts` / `preview-origin.ts` 所有权不重叠；T3 只写验收脚本；T4 只写证据与运维文档。默认按 T1→T2→T3→T4 串行。
- 失败处理：任何本地安全测试仍接受明文 Cookie，T2 不得完成；浏览器或 ACME 环境不可用要记录阻塞；发现与批准 Spec 的实质冲突先取得裁决，不用修改测试掩盖。
