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
