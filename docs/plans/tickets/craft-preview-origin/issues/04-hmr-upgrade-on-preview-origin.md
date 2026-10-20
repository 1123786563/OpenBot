## Parent

- GitHub Issue: #363（已发布，标签 ready-for-agent）
- Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`
- 覆盖验收标准：AC5
- 主战场：`openbot`

## What to build
HMR 升级在新 origin 下的鉴权与路由。`webappHmrSessionIdFromPath` 目前按**路径**取会话 id；host 路由后路径不再含会话 id，须改为从 `Host` 解析（复用 02 的 `resolvePreviewRequest`），鉴权从 session cookie 切到 preview 域 cookie（或 upgrade query 中的 ticket）。

## Acceptance criteria
- [ ] preview origin 下 `/_next/webpack-hmr` 升级成功且帧双向流动（Turbopack 靠它推进 chunk 加载）
- [ ] 未鉴权/过期票/他人会话的升级被拒，且拒绝发生在 `server.upgrade` 提交之前（保持既有语义）
- [ ] upstream 仍为入站 pathname 原样转发（webappHmrUpstreamUrl 的既有正确行为不回退）
- [ ] dev 直连 server 端口与 prod preview origin 两种拓扑都验证

## Contracts
**Consumes**：01 票据、02 Host 解析、现有 `webappHmrSocketHandlers`（帧桥不重复实现）
**Produces**：`resolveWebappHmrUpgrade` 的 host 版本；upgrade 鉴权与 HTTP 代理同源的判定

## Implementation steps
1. 失败测试：host 路由下升级被拒/成功两路
2. `WEBAPP_HMR_PATH` 的正则改为不含会话段的新形状，或直接按 Host 分发
3. 鉴权来源切换，确认票据不入日志
4. 真实浏览器回归：HMR 帧数 > 0 且热更新生效

## Write scope
`server/src/craft/webapp-proxy.ts`、`server/src/index.ts`（upgrade dispatcher）、`server/tests/craft-webapp-hmr.test.ts`。
