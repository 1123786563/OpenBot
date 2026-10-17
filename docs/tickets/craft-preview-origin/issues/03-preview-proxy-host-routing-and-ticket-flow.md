## Parent

- GitHub Issue: #362（已发布，标签 ready-for-agent）

- Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`
- 覆盖验收标准：AC1, AC2
- 主战场：`openbot`

## What to build

预览代理按 Host 头路由到会话（替代按路径 `:sessionId`），`webapp-info` 的 `webapp_url` 绝对化为 preview origin 地址，浏览器完成「主站换票 → preview 域种 cookie → 加载预览」的流程。这是隔离真正生效的一张：改完之后生成代码再也碰不到主站会话。

## Acceptance criteria

- [ ] 生成代码执行 `fetch("http://<主站>/api/craft/sessions", {credentials:"include"})` → **401**
- [ ] 预览文档的 `document.cookie` 不含主站 cookie；`localStorage` 为独立空库
- [ ] 应用自身的 POST/PUT/PATCH/DELETE 全部 200 且到达自己的 route handler（不回退交互能力）
- [ ] Server Actions（POST 到自身路径）可用
- [ ] 前端加载预览前自动换票，票据不出现在最终 URL 与日志
- [ ] `webapp_url` 为绝对地址（已定案 D11），下游逐一核验：preview-tab / webapp-download / 桌面端（Tauri）/ 分享链路
- [ ] 全屏放大、HMR 热更新在预览内不回归（回归保护，深度验证在 06）

## Contracts

**Consumes**

- 01 的 `issuePreviewTicket` / `redeemPreviewTicket`
- 02 的 `resolvePreviewRequest`（Host → 会话）
- 现有 `proxyWebappRequest`（方法与 body 透传已具备，勿重复实现）
- 现有 `webappDevServerReady`（附着模型：只探测不拉起）

**Produces**

- `webapp-info` 的 `webapp_url` 为绝对地址（含 preview origin），新增 `previewOrigin: string | null`
- preview 域的会话 cookie（HttpOnly，由票据兑换时种下）
- 前端 `preview-tab.tsx` 的换票→跳转封装

## Implementation steps

1. 失败测试先行：在同一浏览器上下文里断言跨 origin 调用 401（AC1）
2. 代理路由从 `:sessionId` 切到 Host 解析（02 的 `resolvePreviewRequest`）
3. `webapp-info` 绝对化 + 前端换票封装；确认票据不落 URL
4. 预览域 cookie 的种设与作用域（HttpOnly；SameSite 取值写明理由）
5. 重算并收紧 CSP：`connect-src 'self'` 在新 origin 下的语义
6. 交互回归：四动词 + Server Actions（AC2）

## Write scope

`server/src/craft/webapp-proxy.ts`、`server/src/craft/`（ticket 集成）、`app/src/components/craft/output-panel/preview-tab.tsx`、`app/src/lib/craft/{client,types,queries}.ts`、`server/tests/`。

---

## 来自前置审阅的约束（#360 与 #361 通过时写入，本票设计必须吸收）

### 来自 #361 审阅（直接踩上本票的三项）

1. **M-1 生产形态的 Host 判别**：dev 靠 `127.0.0.1` vs `localhost` 分流；生产必须按配置的 preview 基础域做**后缀匹配**判别，需精确定义并有测试钉住「主站主机绝不被当作 preview」（AC1 的隔离前提）。
2. **M-2 重启空窗**：#361 的 label→session 反查是**内存 registry，server 重启即清空**。已打开的 preview 标签 reload 会得到 404 "Unknown preview host"，恢复须经主站重新走票重铸。本票的代理入口设计二选一：(a) 接受并文档化为已知约束；(b) 改 store/DB 反查。同时修正 #360 遗留注释的事实错误（"a column would only cache what derivation already knows" 对反向不成立），并把重启行为写明。
3. **m-5 `webapp-info` 的关闭原因面**：#361 已把这块整块延迟到本票（代码注释已声明）。落地方案 + 测试由本票交付，避免 AC 勾选争议。

### 来自 #360 审阅

4. **端口语义收敛**：`defaultPreviewOrigin` 在 PORT 与 SERVER_PORT 不一致时静默偏好 PORT，而 `server/src/config.ts` 的 `serverPort` 会抛错 —— 本票收敛（#360 审阅 Nit 3/4）。
5. **消费 #360 交付的接缝**（审阅已确认干净）：`deps.previewTickets` 注入同一实例；`previewSessionCookieHeader` 真正 Set-Cookie 并按 D9 验收；`redeem` 返回 `{userId}`，归属校验在 #360 的 store 重查里，**不要重复实现**；`previewOriginFor` 注入点替换默认实现。

---

## 来自 #361 终审与 OCR 修复轮的补充约束（2026-10-15，coordinator #361 会话写入）

在上方「来自前置审阅的约束」五条之上，#361 的 Pi 终审（`.superpowers/evidence/issue-361/pi-review-361.md`）与 OCR 三轮修复（同目录 ocr-range.md / pi-review-361-fix{,-r2,-r3}.md）新增以下 #362 吸收项：

1. **M-1 扩充——主机名规范化与模板基域合法性**：带尾点通配主机（`x.preview.example.com.`）逃逸 `handlesRequest` 后缀匹配落主站路由（cookie 按 host 隔离使泄露面≈0）；双点退化模板 `https://{session}..` 与 `{session}` 后置 userinfo（`https://{session}.x@evil.com`）仍 OPEN（fail-closed 方向的垃圾配置）；准入时应校验模板基域不得是主站主机的后缀/祖先。M-1 落地时一并定义「主站主机绝不被 claim」规则与测试。
2. **m-5 扩充——签发侧面**：准入关闭时 `POST /api/craft/sessions/:id/preview-ticket` 因 `previewOriginFor→originFor` 抛错变 500（Hono 兜底）；应捕获并透出 `admission().reason` 为可展示 503。
3. **D9 cookie 加固**：https 生产模板下 preview 会话 cookie 应补 `; Secure`（值是 session id，无 Secure 会随明文 http 请求发送）。
4. **契约测试钉死**：预览代理绝不向下游 app 转发 cookie（preview_session cookie 值 = session id）。
5. **设计确认**：craft-off 时 `craftPreviewOrigin` 为 undefined、`127.0.0.1:<port>` 不被 claim 落主站路由——确认预期形状或在 dispatcher 挂接点处理；dev 形态激活时建议 boot 日志声明 127.0.0.1 已被 preview 命领。
6. **依赖收紧**：`CraftRoutesDeps.previewTickets/previewOriginFor` 改必填、移除 webapp-proxy 的 `defaultPreviewOrigin` 回退（防第二票表与无准入铸址路径；生产装配已注入，回退仅测试路径可达）。
7. **备忘**：registry 无逐出（进程生命周期单调增长，随 M-2 二选一定）；HMAC 密钥轮换=全部预览地址重铸（运维文档记一句）；`resolvePreviewRequest` 嵌套三元与死写法顺手重构。

注：#362 实现期间已通过 Orca follow-up 收到其中 1–5 条，其 worker_done 声明已吸收；本节为持久化记录。
