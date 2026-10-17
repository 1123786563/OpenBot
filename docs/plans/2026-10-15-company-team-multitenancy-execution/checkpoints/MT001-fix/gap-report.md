# MT001 多租户覆盖清单 — 缺口报告

- 生成时间：2026-10-15T05:51:27.344Z
- digest：`0965ecfa0ef5a0e6427f66796843bdcc21904d5bd7b670ac7f2b18b5a3fe30c9`
- 入口：539（route 484 / catchall 53；未归属 539；未分类 0）
- 后台程序 13 · 数据表 151 · 外部依赖 22
- 服务面 4（已知部署、未装配、路由未枚举——列出不构成路由覆盖）
- serve() 升级分支 2 个，已登记 stream 入口 2 个

## 装配（入口事实源）

| 装配 | 入口面 | 状态 | 唯一路由 |
| --- | --- | --- | --- |
| deployment-bare | deployment | assembled | 60 |
| deployment-full | deployment | assembled | 526 |
| deployment-enterprise-unavailable | enterprise | assembled | 523 |
| kb-service | kb-service | assembled | 12 |

## 服务面（已知部署 · 未装配 · 路由未枚举 ≠ 已覆盖）

- `agent-computer`（computer，unassembled，路由未枚举，unowned）— compose 构建镜像；由 supervisor 按 Bot 启动独立 computer 容器。容器内部入口面未枚举，仅登记服务面。
  - 证据：docker-compose.yml:60: agent-computer:
- `agent-sandbox`（codesandbox，unassembled，路由未枚举，unowned）— compose 独立沙箱服务镜像。容器内部入口面未枚举，仅登记服务面。
  - 证据：docker-compose.yml:102: agent-sandbox:
- `go-runtime`（agent-runtime，unassembled，路由未枚举，unowned）— Go 独立执行运行时（compose profile go-runtime，默认关闭；企业 run gateway 直连）。跨语言进程无法由本清单装配枚举；仅登记服务面。
  - 证据：docker-compose.yml:423: go-runtime:
  - 证据：runtime-go/cmd/runtime/main.go:167: srv := &http.Server{
- `supervisor`（computer，unassembled，路由未枚举，unowned）— 独立 Bun/Hono 进程（token 门禁）；模块顶层 serve() 自启动，导入即起服务，无法在清单装配内安全枚举路由。仅登记为已知部署服务面，不构成路由覆盖。
  - 证据：supervisor/src/index.ts:77: const app = new Hono();
  - 证据：supervisor/src/index.ts:195: serve({ port, fetch: app.fetch, idleTimeout: 120 });

> 上述服务面为已知部署但未进入四个应用装配的进程；登记不构成路由覆盖，统一上线验收前须为其单独补装配或显式登记为未覆盖。

## 未归属入口（按业务闭环）

### agent-runtime（Agent 运行时）— 未归属 9/9
- `ALL /api/admin/learning/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/copilotkit`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/copilotkit/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/learning/overview`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/learning/settings`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/learning/status/:agentId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/learning/container`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/model-provider/v1/chat/completions`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/admin/learning/settings`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### approvals（审批）— 未归属 19/19
- `ALL /api/approvals/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/approvals/shared-use/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/approvals/rules/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/approvals/team/rules/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/approvals`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/approvals/shared-use`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/approvals/shared-use/bot/:botId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/approvals/preferences`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/approvals/rules/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/approvals/team`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/approvals/team/rules/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/approvals/:id/decision`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/approvals/computer/:botId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/approvals/questions/:id/respond`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/approvals/rules`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/approvals/shared-use`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/approvals/shared-use/:id/approve`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/approvals/shared-use/:id/decline`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/approvals/team/rules`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### billing（计费与付款）— 未归属 21/21
- `ALL /api/admin/billing/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/billing/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/billing`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/billing/catalog`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/billing/credits/consumption`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/billing/credits/grants`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/billing/credits/summary`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/billing/entitlements`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/billing/invoices`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/billing/invoices/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/billing/plan-usage`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/billing/purchases/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/billing/purchases/catalog`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/billing/purchases/current`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/billing/credits/grants`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/billing/reconcile`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/billing/sync`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/billing/purchases`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/billing/purchases/:id/cancel`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/billing/webhooks/lago`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/payments/callbacks/:provider`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### bot（Bot 与团队 Bot）— 未归属 52/52
- `ALL /api/proactive/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/team-bots/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/agents/:agentId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/agents/:agentId/callback-token`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/marketplace/experts/:slug/install`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/marketplace/skills/:slug/install`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/proactive/settings/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/team-bots/:botId/assignments/:group`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/team-bots/:botId/publication`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/team-bots/consents`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /.well-known/http-message-signatures-directory`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/agents`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/agents/:agentId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/agents/:agentId/handoff`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/agents/capabilities`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/bots/:agentId/activity`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/bots/:agentId/lifecycle`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/bots/:agentId/reset`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/bots/attention`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/bots/routing`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/marketplace`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/proactive/settings`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/proactive/suggestions`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/team-bots`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/agents/:agentId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/proactive/settings/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/agents`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/agents/:agentId/callback-token`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/agents/:agentId/declined`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/agents/:agentId/duplicate`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/agents/:agentId/hide`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/agents/:agentId/pin`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/agents/:agentId/unhide`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/agents/:agentId/unpin`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/agents/test-connection`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/bots/:agentId/activity/handoffs/stop`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/bots/:agentId/follow-ups/cancel`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/bots/:agentId/pause`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/bots/:agentId/reset`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/bots/:agentId/resume`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/marketplace/experts/:slug/install`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/marketplace/skills/:slug/install`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/proactive/settings`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/proactive/settings/:id/run`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/proactive/suggestions/:id/dismiss`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/proactive/suggestions/:id/start`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/route`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/team-bots/:botId/assignments`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/team-bots/:botId/consents`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/bots/:agentId/notifications`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/bots/routing/:kind`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/team-bots/:botId/publication`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### codesandbox（代码沙箱）— 未归属 3/3
- `ALL /api/codesandbox/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/codesandbox/reset`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/codesandbox/runs`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### computer（电脑与实例）— 未归属 43/43
- `ALL /api/computers/:botId/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/demonstrations/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/demonstrations/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/computers/:botId/computers`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/computers/:botId/control`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/computers/:botId/files/download`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/computers/:botId/page-frame/:toolCallId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/computers/:botId/read`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/computers/:botId/screenshot`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/computers/:botId/status`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/computers/fleet`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/computers/policy`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/demonstrations`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/demonstrations/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/click`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/computers/reset`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/computers/stop`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/computers/update`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/control/cancel`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/control/release`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/control/request`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/control/revoke`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/control/secret`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/control/take`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/exec`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/files/list`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/files/read`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/files/write`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/human/:kind`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/human/secret`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/key`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/navigate`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/scroll`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/snapshot`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/:botId/type`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/computers/policy-dry-run`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/demonstrations`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/demonstrations/:id/draft`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/demonstrations/:id/published`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/demonstrations/:id/schedule`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/demonstrations/:id/stop`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/computers/policy`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `WS /api/computers/:botId/stream`（stream/serve-upgrade，serve-level，deployment-serve）

### conversation（会话与频道）— 未归属 33/33
- `ALL /api/channels/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/enterprise/conversations/*`（http/catchall，conditional，deployment-enterprise-unavailable）
- `ALL /api/groups/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/attachments/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/channels/:channelId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/groups/:channelId/members/:userId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/attachments/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/channels`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/channels/:channelId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/channels/events`（stream/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/enterprise/conversations`（http/route，conditional，deployment-full）
- `GET /api/enterprise/conversations/:threadId/messages`（http/route，conditional，deployment-full）
- `GET /api/groups/:channelId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/activity`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/workspace`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/threads/:threadId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/channels/:channelId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/channels`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/channels/:channelId/activity`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/channels/:channelId/archive`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/channels/:channelId/attachments`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/channels/:channelId/busy`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/channels/:channelId/unarchive`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/enterprise/conversations`（http/route，conditional，deployment-full）
- `POST /api/enterprise/conversations/:threadId/messages`（http/route，conditional，deployment-full）
- `POST /api/groups`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/groups/:channelId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/groups/:channelId/members`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/conversations`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/threads/mint`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/channels/:channelId/pin`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/channels/:channelId/read`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### craft（Craft）— 未归属 59/59
- `ALL /api/craft/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/craft/mcp/:serverId`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/craft/scheduled-tasks/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/craft/sessions/:sessionId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/craft/sessions/:sessionId/files/:path{.+}`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/craft/sessions/:sessionId/webapp`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/craft/sessions/:sessionId/webapp/:path{.+}`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/scheduled-tasks`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/scheduled-tasks/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/scheduled-tasks/:id/runs`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/approvals/live`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/artifacts`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/artifacts/:path{.+}`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/download-directory/:path{.+}`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/export-docx/:path{.+}`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/files`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/messages`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/pptx-preview/:path{.+}`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/pre-provisioned-check`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/sandbox-status`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/scheduled-run-context`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/scheduled-run-events`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/turns/:turnId/events`（stream/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/turns/active`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/webapp`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/webapp-download`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/webapp-info`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/craft/sessions/:sessionId/webapp/:path{.+}`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `HEAD /api/craft/sessions/:sessionId/webapp`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `HEAD /api/craft/sessions/:sessionId/webapp/:path{.+}`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `OPTIONS /api/craft/sessions/:sessionId/webapp`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `OPTIONS /api/craft/sessions/:sessionId/webapp/:path{.+}`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/craft/sessions/:sessionId/public`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/craft/sessions/:sessionId/webapp`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/craft/sessions/:sessionId/webapp/:path{.+}`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/approvals/:approvalId/decision`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/apps/connect/:requestId/decision`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/kb-search`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/scheduled-tasks`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/scheduled-tasks/:id/run`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/scheduled-tasks/:id/run-now`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/sessions`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/sessions/:sessionId/generate-name`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/sessions/:sessionId/interrupt`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/sessions/:sessionId/restore`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/sessions/:sessionId/send-message`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/sessions/:sessionId/skills/reload`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/sessions/:sessionId/snapshot`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/sessions/:sessionId/subagents/:ocSessionId/send-message`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/sessions/:sessionId/upload`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/sessions/:sessionId/webapp`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/craft/sessions/:sessionId/webapp/:path{.+}`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/craft/scheduled-tasks/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/craft/sessions/:sessionId/name`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/craft/sessions/:sessionId/webapp`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/craft/sessions/:sessionId/webapp/:path{.+}`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `WS /^\/api`（stream/serve-upgrade，serve-level，deployment-serve）

### credentials（凭据与密码库）— 未归属 12/12
- `ALL /api/passwords/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/sign-in-requests/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/passwords/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/passwords`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/sign-in-requests`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/sign-in-requests/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/sign-in-requests`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/sign-in-requests/:id/cancel`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/sign-in-requests/:id/finish`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/sign-in-requests/:id/submit`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/sign-in-requests/:id/take-over`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/sign-in-requests/:id/use-saved`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### delivery（投递通道）— 未归属 17/17
- `ALL /api/delivery/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/delivery/webhooks/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/delivery/bindings/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/delivery/devices/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/delivery`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/delivery/conversations`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/delivery/conversations/:id/history`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/delivery/conversations/:id/messages`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/delivery/devices`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/delivery/opentag/start`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/delivery/slack/start`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/delivery/sms/confirm`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/delivery/sms/start`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/delivery/teams/start`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/delivery/webhooks/opentag/agent`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/delivery/webhooks/sms`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/delivery/webhooks/sms/status`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### governance（治理与管理审计）— 未归属 23/23
- `ALL /api/admin/enterprise/*`（http/catchall，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/admin/enterprise/network/:scopeKind`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/admin/identity-providers/:providerId`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/audit-events`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/credentials`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/enterprise`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/enterprise/actions`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/enterprise/me`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/enterprise/models/usage`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/identity-providers`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/package`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/people`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/status`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/credentials`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/credentials/:credentialId/revoke`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/credentials/:credentialId/rotate`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/enterprise/computers/terminate-inactive`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/enterprise/people/:userId/terminate-computers`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/people/:userId/access`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/people/:userId/role`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `PUT /api/admin/enterprise/capabilities`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `PUT /api/admin/enterprise/network`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `PUT /api/admin/enterprise/settings/:key`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）

### host-access（主机访问）— 未归属 6/6
- `DELETE /api/host-access/grants/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/host-access`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/host-access/desktop/next`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/host-access/desktop/result`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/host-access/grants`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/host-access/stop`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### identity（身份与组织）— 未归属 20/20
- `ALL /api/identity/*`（http/catchall，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `ALL /api/identity/github/callback`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/settings/preferences/*`（http/catchall，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/auth/scim/*`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/identity/links/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/auth/*`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/identity/github/callback`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/identity/links`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/identity/providers`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/me`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/settings/instructions`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/settings/preferences`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/auth/scim/*`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/settings/preferences`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/auth/*`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/identity/challenges`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/identity/github/connect`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/me/onboarding`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `PUT /api/auth/scim/*`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `PUT /api/settings/instructions`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）

### internal-worker（内部 Worker 入口）— 未归属 1/1
- `POST /internal/routines/run`（internal/route，conditional，deployment-full+deployment-enterprise-unavailable）

### knowledge（知识库）— 未归属 21/21
- `ALL /api/knowledge/*`（http/catchall，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/knowledge/kb/:id`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/knowledge/kb/:id/documents/:docId`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `DELETE /kb/:kbId`（http/route，always，kb-service）
- `DELETE /kb/:kbId/documents/:docId`（http/route，always，kb-service）
- `GET /api/knowledge/kb`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/knowledge/kb/:id`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/knowledge/kb/:id/documents`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/knowledge/kb/:id/documents/:docId`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/knowledge/kb/:id/tasks/:taskId`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /kb`（http/route，always，kb-service）
- `GET /kb/:kbId`（http/route，always，kb-service）
- `GET /kb/:kbId/documents`（http/route，always，kb-service）
- `GET /kb/:kbId/documents/:docId`（http/route，always，kb-service）
- `GET /kb/:kbId/tasks/:taskId`（http/route，always，kb-service）
- `POST /api/knowledge/kb`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/knowledge/kb/:id/documents`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/knowledge/kb/:id/retrieve`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /kb`（http/route，always，kb-service）
- `POST /kb/:kbId/documents`（http/route，always，kb-service）
- `POST /kb/:kbId/retrieve`（http/route，always，kb-service）

### memory（记忆）— 未归属 11/11
- `ALL /api/memory/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/memory/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/memory/sources/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/memory`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/memory/sources`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/memory/sources/available/:botId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/memory/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/memory/sources/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/memory`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/memory/sources`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/memory/sources/:id/sync`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### openmuse（OpenMuse 业务）— 未归属 77/77
- `ALL /api/admin/openmuse-ops/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/admin/openmuse-template/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/openmuse-account/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/openmuse-activity/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/openmuse-calendar/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/openmuse-files/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/openmuse-goals/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/openmuse-google/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/openmuse-ideas/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/openmuse-mail/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/openmuse-memories/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/openmuse-notifications/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/openmuse-reviewed-actions/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/mobile/openmuse-tasks/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/mobile/openmuse-files/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/mobile/openmuse-goals/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/mobile/openmuse-ideas/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/mobile/openmuse-memories/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/openmuse-ops/signals`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/openmuse-template/preview`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-activity`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-calendar`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-files`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-files/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-files/:id/content`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-goals`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-goals/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-google`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-google/:provider/status`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-google/status`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-ideas`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-ideas/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-mail`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-mail/threads/:threadId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-mail/threads/:threadId/messages/:messageId/attachments/:attachmentId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-mail/threads/:threadId/messages/:messageId/attachments/:attachmentId/content`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-memories`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-memories/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-notifications`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-notifications/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-reviewed-actions`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-reviewed-actions/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-tasks`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/mobile/openmuse-tasks/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/public/openmuse-google/callback`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/mobile/openmuse-files/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/mobile/openmuse-goals/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/openmuse-template/apply`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-account/delete`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-activity/:id/decision`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-activity/:id/read`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-bot`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-files`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-files/:id/fill`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-files/:id/inspect`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-files/:id/transfer`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-files/import/gmail-attachment`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-goals`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-google/:provider/connect`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-google/:provider/disconnect`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-google/:provider/refresh`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-google/connect`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-ideas`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-ideas/:id/accept`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-ideas/:id/withdraw`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-memories`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-notifications/:id/read`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-reviewed-actions`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-reviewed-actions/:id/cancel`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-reviewed-actions/:id/decision`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-reviewed-actions/:id/reconcile`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-tasks`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-tasks/:id/cancel`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-tasks/:id/pause`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-tasks/:id/resume`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-tasks/:id/retry`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/mobile/openmuse-tasks/:id/wait/:waitId/answer`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### openmuse-deletion（删除恢复）— 未归属 5/5
- `ALL /api/admin/openmuse-deletion/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/admin/openmuse-deletion/cleanup`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/openmuse-deletion/:userId/purge`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/openmuse-deletion/:userId/purge-relational`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/admin/openmuse-deletion/:userId/restore`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### platform（平台与静态面）— 未归属 7/7
- `ALL /*`（http/catchall，always，deployment-bare+deployment-full+deployment-enterprise-unavailable+kb-service）
- `ALL /api/*`（http/catchall，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /*`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/capabilities`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/desktop/connection-failure`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /health`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable+kb-service）
- `GET /ready`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）

### plugins（插件与组件）— 未归属 41/41
- `DELETE /api/components/:name/functions/:function`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/components/:name/grants/:agentId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/plugins/grants`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/plugins/servers/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/plugins/servers/:id/connection`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/plugins/skills/:slug`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/sandboxed/:name`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/components`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/components/for-agent/:agentId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/components/functions`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/plugins`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/plugins/composio/apps`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/plugins/connections`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/plugins/for/:agentId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/plugins/oauth/callback`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/plugins/openconnector/apps`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/sandboxed`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/sandboxed/published`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/agent-tools/call`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/components/:name/call`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/components/:name/decision`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/components/:name/functions`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/components/:name/grants`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/components/:name/publication`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/plugins/call`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/plugins/composio/apps`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/plugins/grants`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/plugins/openconnector/apps`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/plugins/servers`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/plugins/servers/:id/connect`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/plugins/servers/:id/connection/confirm`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/plugins/servers/:id/connection/recheck`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/plugins/servers/:id/oauth-client`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/plugins/servers/:id/refresh`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/plugins/servers/custom`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/plugins/skills`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/sandboxed`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/sandboxed/:name/publish`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/components/:name/draft`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/components/catalogue`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/plugins/servers/:id/account-mode`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### responsibilities（职责与定时任务）— 未归属 32/32
- `ALL /api/events/email/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/events/github/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/events/triggers/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `ALL /api/responsibilities/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/responsibilities/sources/github/:bindingId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/responsibilities/triggers/:triggerId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/routines/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/responsibilities`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/responsibilities/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/responsibilities/:id/runs`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/responsibilities/:id/triggers`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/responsibilities/sources/github`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/responsibilities/triggers/:triggerId/secret`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/routines`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/routines/:id/runs`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/responsibilities/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/responsibilities/triggers/:triggerId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/events/email/sns`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/events/github/:bindingId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/events/triggers/:triggerId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/responsibilities`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/responsibilities/:id/complete`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/responsibilities/:id/pause`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/responsibilities/:id/progress`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/responsibilities/:id/resume`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/responsibilities/:id/run`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/responsibilities/:id/triggers`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/responsibilities/sources/github`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/responsibilities/triggers/:triggerId/secret`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/routines/:id/run`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/responsibilities/triggers/:triggerId/enabled`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PUT /api/routines/:id/enabled`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

### voice（语音与听写）— 未归属 8/8
- `ALL /api/audio/*`（http/catchall，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `ALL /api/voice/*`（http/catchall，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `ALL /api/voice/sessions/*`（http/catchall，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/voice/config`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `GET /api/voice/sessions`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/audio/transcriptions`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/voice/calls`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）
- `POST /api/voice/sessions`（http/route，always，deployment-bare+deployment-full+deployment-enterprise-unavailable）

### workshop（Workshop）— 未归属 19/19
- `ALL /api/workshop/*`（http/catchall，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/workshop/:channelId/schedules/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `DELETE /api/workshop/:channelId/share`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/public/workshop/:channelId/public/artifacts`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/public/workshop/:channelId/public/artifacts/:artifactId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/public/workshop/:channelId/public/preview/*`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/workshop/:channelId`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/workshop/:channelId/artifacts/:id/download`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/workshop/:channelId/events`（stream/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/workshop/:channelId/files`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/workshop/:channelId/schedules`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `GET /api/workshop/:channelId/turns/:id/events`（stream/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `PATCH /api/workshop/:channelId/schedules/:id`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/workshop/:channelId/files/upload`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/workshop/:channelId/reset`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/workshop/:channelId/schedules`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/workshop/:channelId/share`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/workshop/:channelId/turns`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）
- `POST /api/workshop/:channelId/turns/:id/cancel`（http/route，conditional，deployment-full+deployment-enterprise-unavailable）

## 数据表 — 共 151 张；未归属 151；未分类 25
- 未分类示例：server.action_policy, server.action_records, server.attachments, server.brokered_connections, server.capability_settings, server.composio_connections, server.default_opt_outs, server.deployment_packages, server.intelligence_channel_mappings, server.learning_settings, server.learning_thread_bindings, server.model_usage, server.network_policies, server.personal_memories, server.push_devices, server.responsibilities, server.revoked_access, server.saved_logins, server.sign_in_requests, server.skill_tools

## 后台程序（静态候选提取）
- main（responsibilities，unowned）— ../worker/src/index.ts:190: void main();
- cull-idle-computers（computer，unowned）— scripts/cull-idle-computers.ts:4: * Run from a CronJob rather than from a timer inside the API. Every replica would fire its own timer
- cull-staged-attachments（conversation，unowned）— scripts/cull-staged-attachments.ts:9: * Run from a CronJob rather than from a timer inside the API, for the reason the computer culler
- fire-routines（responsibilities，unowned）— scripts/fire-routines.ts:4: * Run from a CronJob rather than from a timer inside the API, for the reason the culler states: every
- fire-workshop-schedules（workshop，unowned）— scripts/fire-workshop-schedules.ts:4: * Run from a CronJob rather than a timer inside the API, for fire-routines' reason: every
- learningAutoAssign（agent-runtime，unowned）— src/index.ts:715: learningAutoAssign.start();
- startChannelActivityListener（unclassified，unowned）— src/index.ts:872: const channelActivityListener = await startChannelActivityListener(
- startPaymentSweeps（billing，unowned）— src/index.ts:4198: const paymentSweeps = startPaymentSweeps(paymentService, {
- startPolicyListener（unclassified，unowned）— src/index.ts:964: const policyListener = await startPolicyListener(
- startRetentionSweeps（governance，unowned）— src/index.ts:1128: const retentionSweeps = startRetentionSweeps(
- startUsageDeliverySweeps（billing，unowned）— src/index.ts:4030: const usageSweeps = startUsageDeliverySweeps(usageDelivery, {
- startWorkOfferedListener（unclassified，unowned）— src/index.ts:3552: workOfferedListener = await startWorkOfferedListener(
- worker（knowledge，unowned）— src/kb/worker.ts:83: const worker = new Worker(

## 外部依赖（配置面提取）
- Composio 应用目录（plugins）：COMPOSIO_API_KEY
- CopilotKit Runtime（agent-runtime）：COPILOTKIT_LICENSE_TOKEN
- Docreader 文档解析服务（knowledge）：DOCREADER_ADDR, DOCREADER_CALL_TIMEOUT_MS
- GitHub App（identity）：GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET
- Intelligence 运行时（agent-runtime）：INTELLIGENCE_API_KEY, INTELLIGENCE_PROJECT_ID, INTELLIGENCE_SERVICE_TOKEN
- Lago 计费（billing）：LAGO_ALLOW_PRIVATE_HOSTS, LAGO_API_KEY, LAGO_API_URL, LAGO_PLAN_CATALOG, LAGO_PLAN_ENTITLEMENTS, LAGO_PLAN_QUOTAS, LAGO_REQUEST_TIMEOUT_MS, LAGO_WEBHOOK_PUBLIC_KEY, LAGO_WEBHOOK_SECRET
- Ollama 嵌入（knowledge）：OLLAMA_BASE_URL
- OpenConnector（openmuse）：OPENCONNECTOR_ADMIN_TOKEN, OPENCONNECTOR_URL
- PostgreSQL（KB 服务库）（knowledge）：KB_DATABASE_URL
- PostgreSQL（主库）（platform）：DATABASE_URL
- PostgreSQL（企业数据库）（conversation）：ENTERPRISE_DATA_DATABASE_URL
- PostgreSQL（企业目录库）（identity）：ENTERPRISE_DIRECTORY_DATABASE_URL
- Qdrant 向量库（knowledge）：KB_QDRANT_BATCH, QDRANT_API_KEY, QDRANT_URL
- Redis（KB BullMQ 队列）（knowledge）：KB_REDIS_URL
- Redis（workshop 总线与锁）（workshop）：OPENBOT_REDIS_URL, WORKSHOP_REQUIRE_REDIS
- Reranker 服务（knowledge）：KB_RERANK_URL
- agent-computer 服务（computer）：AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS, AGENT_COMPUTER_POLICY, AGENT_COMPUTER_URL
- computer 基础设施（computer）：COMPUTER_SUPERVISOR_URL, COMPUTER_TOKEN
- 代码沙箱（codesandbox）：COMPUTER_SANDBOX_IDLE_AFTER, COMPUTER_SANDBOX_NAMESPACE, COMPUTER_SANDBOX_TEMPLATE_FILE
- 受管 Agent（AG-UI）（agent-runtime）：MANAGED_AGENT_TOKEN
- 微信支付（billing）：WXPAY_API_V3_KEY, WXPAY_APPID, WXPAY_GATEWAY_URL, WXPAY_MCHID, WXPAY_PLATFORM_CERTS, WXPAY_PRIVATE_KEY, WXPAY_SERIAL_NO
- 支付宝（billing）：ALIPAY_APP_ID, ALIPAY_GATEWAY_URL, ALIPAY_PRIVATE_KEY, ALIPAY_PUBLIC_KEY
- 未映射配置键（待归类）：AGENT_STALL_TIMEOUT_MS, AGENT_TOOL_TOKEN, APP_DIST_DIR, AUDIT_RETENTION_DAYS, BATCH_EMBED_SIZE, BETTER_AUTH_SECRET, BETTER_AUTH_URL, BILLING_CODE_RUN_MAX_RESERVATION_TOKENS, CPK_INTELLIGENCE_LEARNING_CONTAINER_ID, CPK_INTELLIGENCE_SKILLS_REVISION, DEPLOYMENT_ID, KB_API_KEYS, KB_DEFAULT_TOP_K, KB_EMBED_DIMENSIONS, KB_EMBED_MAX_CONCURRENCY, KB_EMBED_MODEL, KB_KEYWORD_THRESHOLD, KB_PORT, KB_RERANK_ENABLED, KB_RERANK_MODEL, KB_RERANK_THRESHOLD, KB_RERANK_TOP_K, KB_VECTOR_THRESHOLD, KEY_ENCRYPTION_KEY, MAX_FILE_SIZE_MB, MICROSOFT_OAUTH_TENANT_ID, NODE_ENV, OPENBOT_ACCESSIBILITY_DISABLED, OPENBOT_APP_URL, OPENBOT_EMAIL_PASSWORD, OPENBOT_GENERATIVE_UI, OPENBOT_LEARNING_AUTO_ASSIGN, OPENBOT_PUBLIC_URL, OPENBOT_SELF_HOST_BANNER, OPENBOT_TENANT_STORAGE_RUNTIME_DATABASE_URL, PAYMENT_ALLOW_PRIVATE_HOSTS, PAYMENT_NOTIFY_BASE_URL, PAYMENT_PLAN_CATALOG, PICKED_HARNESS_IMAGE, PORT, SERVER_PORT, STORAGE_LOCAL_PATH, SUPERVISOR_TOKEN, TENANT_PACKAGE_DIR, WORKER_SHARED_SECRET

## 数据库阶段（显式跳过 = 未通过，不静默）
- live-table-crosscheck: skipped — TEST_DATABASE_URL 未配置；拒绝回退 DATABASE_URL（专用测试库要求）。静态清单已完整生成，仅跳过在线表清单比对。
- enterprise-capability-assembly: skipped — 企业目录/数据/租户运行时数据库未全部配置；生产装配在该条件下挂载 createUnavailableConversationRoutes()（已由 deployment-enterprise-unavailable 装配单独覆盖），真实能力装配未验证。
