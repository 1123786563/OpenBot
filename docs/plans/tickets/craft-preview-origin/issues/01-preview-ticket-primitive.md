## Parent

- GitHub Issue: #360（已发布，标签 ready-for-agent）

- Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`（批准后发布为 GitHub Issue 并回填）
- 覆盖验收标准：AC4
- 主战场：`openbot`

## What to build

Preview ticket 鉴权原语：主站 cookie 换一张短时、单会话作用域、单次使用的票据；票据在 preview origin 上兑换为该域自己的会话凭据。这是整个独立 origin 设计的鉴权基础（D4）——跨主机后 session cookie 不随行。

## Acceptance criteria

- [ ] `POST /api/craft/sessions/:id/preview-ticket` 仅接受主站会话 cookie，返回 `{ ticket, expiresAt, origin }`
- [ ] 票据绑定三元组 (userId, sessionId, previewHost)，任何一元不匹配即拒绝
- [ ] 票据单次使用：兑换成功后立即作废；重放同一票据被拒
- [ ] TTL 到期被拒（**30 秒**，已定案 D9）
- [ ] 会话被删除/用户变更时未兑换票据作废
- [ ] 兑换成功时在 preview 域种会话级 HttpOnly cookie（无 Max-Age/Expires，浏览器关闭即失效）—— 已定案 D9
- [ ] 不做"预览空闲 N 分钟后作废"（已定案 D9：TTL 只看 30s 窗口）
- [ ] 票据不出现在日志（含结构化日志的 msg/字段），错误响应不回显票据值
- [ ] 时钟推进测试覆盖过期路径（不依赖 sleep）

## Contracts

**Consumes**

- 现有会话归属判定：`CraftStore.getSession(id, userId)` 与 `botIdFor(sessionId)`（server/src/craft/store.ts、server/src/craft/webapp-proxy.ts 的 `resolveWebappHmrUpgrade` 同款语义）
- 现有拒绝形状：401 / 404 / 503（HTTP 预览代理与 HMR 升级均已使用，保持一致）

**Produces**

- `issuePreviewTicket({ sessionId, userId, previewHost }) -> { ticket, expiresAt }`
- `redeemPreviewTicket({ ticket, sessionId, previewHost }) -> { userId } | { reason }`
- 存储放内存 TTL 表（票据本就是短命对象，不引入持久化 schema）；须可注入时钟供测试

## Implementation steps

1. 定义票据载荷与签名/随机性（建议 32 字节随机 + 服务端内存表，不需要 JWT）
2. 签发路由 + 归属校验（复用 401/404/503 形状）
3. 兑换函数：单次使用标记、TTL、三元组匹配，全部先写失败测试
4. 注入时钟的过期测试（推进时钟，不 sleep）
5. 确认票据值不进入任何日志字段（grep 证据）

## Write scope

`server/src/craft/`（新文件 preview-ticket.ts + webapp-proxy.ts 挂路由）、`server/tests/craft-preview-ticket.test.ts`。不改预览代理的既有路由行为。
