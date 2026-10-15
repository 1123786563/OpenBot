## Parent

- GitHub Issue: #361（已发布，标签 ready-for-agent）

- Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`
- 覆盖验收标准：AC6, AC9（另为 01 的 AC4 提供准入面，但票据语义归 01）
- 主战场：`openbot`

## What to build

主机名用 **hash，不用明文 session id**（已定案 D7/AC9）：派生必须稳定、不可枚举、DNS 标签安全，且服务端可反查到会话。

Preview origin 的承载与功能准入。决定 preview origin 与主站是否由**同一进程同一端口**按 `Host` 头分发（部署最简，需先核验 Bun 能否在同一 listener 上分流 HTTP 与 upgrade），否则落到第二端口。未配置 preview 域名/无泛域名证书时，功能显式关闭并给出可展示原因，**不静默回退同源形态**。

## Acceptance criteria

- [ ] 同一端口上按 `Host` 分发：主站 origin 走既有路由，preview origin 走预览代理（或证明需要第二端口并落地）
- [ ] `webappProxyEnabled` 之外新增 preview origin 准入：未配置 → `webapp-info` 返回可展示的关闭原因，预览路由 503 且带原因
- [ ] 准入关闭时绝不回退到同源形态（grep 证据：不存在绕过准入的预览入口）
- [ ] `Host` 头与会话的映射有校验：未知主机名一律 404，不落到主站路由
- [ ] 子域名不是 session id 本身或其可直接解码形式；枚举子域名不能发现其它会话（AC9）
- [ ] 同一会话在其存活期内解析到同一主机名（地址不漂移）
- [ ] 反查机制选定并写明理由：会话行新增列 vs 服务端 KV（Spec 实施前置核验已放开，由本 Ticket 选定）
- [ ] dev 默认 `127.0.0.1:<SERVER_PORT>` 可用（实测已证明与 `localhost` 隔离生效）

## Contracts

**Consumes**

- 01 的 preview ticket（兑换发生在 preview origin 的入口上）
- `CraftConfig`（新增 `previewOriginEnabled` / `previewOriginTemplate`，config.ts 既有 boolEnv/stringEnv 模式）

**Produces**

- `resolvePreviewRequest(request) -> { sessionId } | { refuse }`：Host 头 → 会话 id 的唯一入口
- `CraftConfig.previewOrigin{Enabled,Template}` 与可展示的关闭原因文案

## Implementation steps

1. 先做 Bun 单端口 Host 分流的可行性核验（HTTP + WS upgrade 各一），写进本 Ticket 的 checkpoint
2. 若不可行：第二端口的 compose/config 变更与本 Ticket 一起交付
3. Host 解析 + 校验，未知主机 404
4. 准入开关 + 关闭原因文案（与 webapp 代理的拒绝形状一致）
5. 失败测试先行：未知主机、未配置、准入关闭

## Write scope

`server/src/craft/`（config.ts、新文件 preview-origin.ts）、`server/src/index.ts`（仅 dispatcher 的分支挂接）、`server/tests/craft-preview-origin.test.ts`。
