# Fixture F4 — 审批拒绝 + connect_app 拒绝/超时/放行

> 全部期望值派生自 Onyx 源(pinned `251933a`,路径相对 `backend/onyx/server/features/build/`,下称 B/)。

## A. egress-proxy 审批:用户拒绝

### 输入

沙箱内 agent 发起被 gate 的外呼(如经 MCP/HTTP 调外部 app 写操作),proxy 停车并写 `ActionApproval` 行;用户在卡上点 **Deny**:`POST /build/approvals/{approval_id}/decision`,body `{"decision": "rejected"}`。

### 期望(B/`approvals/api.py`)

- 200,返回 `ApprovalView`;行 `decision=REJECTED, decided_via=USER`(:163-168)。
- 决策后对 proxy 停车请求的唤醒:`approval_cache.send_wake(approval_id, REJECTED)`(:88-97, 196)。
- **幂等/冲突**:同决策重复 POST → 200 原行(:104-105);异决策 → `CONFLICT`,detail `"decision already recorded (approved)"`(:106-117,existing 取 `view.decision.value`)。
- 超时面:proxy 停车窗口 = `SANDBOX_APPROVAL_WAIT_TIMEOUT_SECONDS` = 180s(`configs.py:32-34`);live 列表只回 `created_at >= now-180s` 的 pending 行(:130-141);`is_live` 同窗口(:67-75)。EXPIRED 只由 proxy 服务端在超时写入(:40-43 注释)。
- **Agent 侧可观察结果**(proxy 应答):HTTP 403 + JSON body `"error": "user_rejected"`(语义锚:B/`AGENTS.template.md:78-79` — `user_rejected | not_authorized | policy_denied` 三值;agent 指令"Surface the issue and don't retry",:17, :79)。

### OpenBot 环境等价替代(实现方对照,不作为断言来源)

OpenBot 无 egress proxy;拒绝路径 = gated 工具 permission → `answer_permission(allow=false)` → opencode `{"response":"reject"}`(B/`sandbox/opencode/serve_client.py:1704-1736` 的协议形态)。断言采用:**decide 落行 + 上游收到拒绝 + turn 不因拒绝中断**(拒绝是工具结果,不是 turn 错误)。

## B. connect_app:用户拒绝(declined)

### 输入

agent 调 `connect_app(external_app_id=7, reason="Need Slack to post updates")`;opencode 发 `permission.asked {permission: "connect_app", patterns: ["7"], metadata: {external_app_id: 7, reason: "Need Slack to post updates"}}`(工具定义 B/`sandbox/image/opencode-plugins/connect-app.ts:52-64`)。

### 工具 schema(逐字节,B/`sandbox/image/opencode-plugins/connect-app.ts:36-51`)

```ts
        description:
          "Ask the user to connect an org app you aren't set up to use yet. " +
          "Pass the app's numeric ID (as listed under 'Connectable apps' in AGENTS.md). " +
          "This pauses for the user to connect it. If this returns normally the " +
          "app is connected and you can use it; if it is denied, do not retry — " +
          "offer an alternative.",
        args: {
          external_app_id: tool.schema
            .number()
            .int()
            .describe("Numeric ID of the connectable app, e.g. 42"),
          reason: tool.schema
            .string()
            .optional()
            .describe("One short sentence on why you need it, shown to the user"),
        },
```

- 拼接后的 description 运行时值:`Ask the user to connect an org app you aren't set up to use yet. Pass the app's numeric ID (as listed under 'Connectable apps' in AGENTS.md). This pauses for the user to connect it. If this returns normally the app is connected and you can use it; if it is denied, do not retry — offer an alternative.`
- args:`external_app_id` = `number().int()`(必填);`reason` = `string().optional()`。

### 期望:api-server 侧(B/`sandbox/opencode/serve_client.py:1738-1811`)

- Redis 写两条:
  - pending:`craft:connect_app:pending:{request_id}` = `{"build_session_id":…, "opencode_session_id":…, "perm_id":…, "directory":…}`,TTL 30min(B/`connect_app.py:39-54, 83-87`);
  - announce:`craft:connect_app:announce:{build_session_id}` RPUSH `ConnectAppRequest.model_dump_json()`,TTL 60s(B/`connect_app.py:49-63`)。
- 超时兜底登记:deadline = now + 180s(:1809-1811);消费循环每秒检查,超时即 `answer_permission(allow=False)`(:1813-1827)。
- metadata 缺 `external_app_id` 或不可 `int()` → **立即 deny**(:1750-1775),不 announce。

### 期望:SSE 卡(live worker BLPOP announce 后)

```json
{"type": "connect_app_request", "request_id": "<uuid4>", "external_app_id": 7, "reason": "Need Slack to post updates", "timestamp": "<iso8601-utc>"}
```
包定义 B/`packets.py:78-89`;SSE 序列化点 = `_format_packet_event`(B/`session/streaming.py:292-294`)的 `packet.model_dump_json(by_alias=True)` —— 未传 `exclude_none`(Pydantic 缺省保留 None 字段;`BasePacket` 亦无 exclude 配置,`packets.py:37-43`),故 **`reason` 为 None 时 wire 上为 `"reason": null`,不省略**;`reason` 来自 metadata,空串转 None(`serve_client.py:1796`)。

### 期望:用户拒绝

`POST /build/apps/connect/{request_id}/decision`,body `{"decision": "declined"}`(B/`external_apps/api.py:436-472`):

- pending 存在 + 会话属本人 + 沙箱 RUNNING → `answer_connect_app_permission(allow=False)` → opencode `{"response":"reject"}`(B/`serve_client.py:1711`)→ 成功后 `clear_pending(request_id)`(:472)。
- **Agent 收到的工具结果(逐字节,connect-app.ts:66-73)**:

```
The user declined to connect external app 7. Do not retry connecting it; offer an alternative or proceed without it.
```

(工具 execute 捕获拒绝、**返回普通结果**而非抛错 —— turn 继续不中断,:65-73。)

### 期望:decision 端点错误分支(api.py:446-471)

| 情形 | 响应 |
|---|---|
| pending 过期/已答/不存在 | 200 no-op(静默) |
| 会话非本人 | 404 `"Connect request not found."` |
| 沙箱非 RUNNING | 503 `"Sandbox is not running."` |
| 沙箱应答失败 | 502 `"Could not reach the sandbox to apply your choice — please try again."`,**pending 保留**(TTL 内可重试) |

## C. connect_app:超时(无人决策)

### 输入

同 B,但 180s 内无 decision。

### 期望

- `_reject_expired_connect_app_permissions` 对每个过期 perm_id 发 reject(serve_client.py:1813-1827);agent 工具结果与 B 的拒绝字符串**逐字相同**(插件 catch 块不区分拒绝来源)。
- announce TTL 60s 已过 ⇒ live 卡自然消失;pending 30min 后自然过期 ⇒ 迟到的 decision 走 200 no-op 分支。

## D. connect_app:放行(connected)

### 期望

- decision `"connected"` → `allow=True` → opencode `{"response":"once"}`(serve_client.py:1711;Onyx 对 opencode 恒答 `once`,session-grant 只作用于 proxy 缓存,不改变此应答)。
- **Agent 收到的工具结果(逐字节,connect-app.ts:74)**:

```
External app 7 is connected. You can use it now.
```

- 连接后刷新面:若走凭证端点 `POST /build/apps/{id}/credentials` 成功 → `push_skills_for_users({user})`(B/`external_apps/api.py:396-399`)⇒ 该用户沙箱 skills/AGENTS 重推 ⇒ `skills_hash` 变 ⇒ 会话 `session_runtime_stale` ⇒ 前端提示 reload(B/`session/manager.py:360-437`)。**该 app 随后从 connectable 列表消失**(F2 的过滤器)。

## E. 审批/连接卡的 SSE 语义边界

- Onyx 侧 serve_client 对非 connect_app 的 `permission.asked` 一律 **WARN + auto-allow**(serve_client.py:1692-1702)—— 审批从不经此通道。OpenBot 的 gated 工具 ask 是环境替代,须保持同样的"拒绝=工具结果、非 turn 错误"不变量。
- 工具卡标题:connect_app/webapp 不在 `_TOOL_TITLE` 表(serve_client.py:185-206)→ 标题回落 `"Running tool"`、kind `"other"`(:209-214)。
