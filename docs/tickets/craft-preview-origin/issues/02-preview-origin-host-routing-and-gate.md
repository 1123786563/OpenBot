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

---

## 来自 #360 审阅的约束（2026-10-15，审阅通过时写入）

实现 #360 时已交付并由审阅确认的接缝，本票**必须**按此消费：

1. **实际种 cookie（D9 闭环）**：#360 只交付了 `previewSessionCookieHeader` 形状（会话级、HttpOnly、Path=/、SameSite=Lax、**无 Max-Age/无 Expires**）。本票的兑换路由要真正 `Set-Cookie`，并按 D9 验收「浏览器关闭即失效」—— 断言不得引入 Max-Age/Expires。
2. **userId 校验藏在 store 重查里**：`redeem` 返回 `{userId}`，其归属校验靠 #360 在兑换时对 store 做 bump-free 重查（`findSession(entry.sessionId, entry.userId)`）。本票消费时不要再假设 redeem 入参带 userId 三元组，也不要重复实现归属校验。
3. **注入同一实例**：`deps.previewTickets` 必须注入 #360 暴露的同一 `previewTickets` 实例（类型已在 `WebappProxyRoutesDeps` 暴露）；routes.ts 装配处显式传引用，不得新建实例。
4. **origin 准入接入时替换注入**：`previewOriginFor` 目前默认走 `defaultPreviewOrigin()`（D5 dev 形态读 PORT/SERVER_PORT）；本票接入 origin 准入时替换该注入，并收敛与 `server/src/config.ts` `serverPort` 的端口语义（#360 审阅 Nit 3/4 的跟进项）。

---

## 验收记录（2026-10-15，coordinator #361 会话）

**状态：verified（#361 切片范围内）**。实现 = `91a2dee7`（已提交，执行分支）+ 三轮 OCR 修复（未提交检查点，见下）。

### 检查点

- 基线：`91a2dee7`（父 `073a7d41`），worktree `impl-361-host-routing`。
- 修复检查点（未提交 diff，仅 `server/src/craft/preview-origin.ts` + `server/tests/craft-preview-origin.test.ts`）：
  累计 `git diff` sha256 `96b8a2b89d37178272aeffb8cb2406fef7aa067e5cb47c0ef140423fad58eb9c`；
  文件 sha256：preview-origin.ts `873d9f5a17615df9…`、craft-preview-origin.test.ts `25a8d6528da32ab5…`。
- 证据目录：执行工作区 `.superpowers/evidence/issue-361/`（Pi 终审/复审×3/OCR range+workspace×3）与
  `impl-361-host-routing/.superpowers/evidence/issue-361/`（探针 22/22×3 轮）。

### 验证结论

- Bun 单端口 Host 分流（HTTP + WS upgrade）经活监听探针与 Pi 独立复跑证实（票面 step 1/m-3 的 checkpoint 记录即此处）。
- 票面 8 条 AC 全部成立；#360 四条消费约束全部落实；AC9 全量交付；AC6 生产半边（未配置模板的显式关闭面 + webapp-info 原因面）按裁决移交 #362（M-1/M-2/m-5），非静默缩减。
- 真实浏览器安全证据（非单测桩）：localhost 主站 cookie 不随请求到 127.0.0.1 预览 origin、`document.cookie` 为空、平台 API 路径在 preview host 上 404 不落主站路由、D9 cookie HttpOnly 且无 Max-Age/Expires。
- 测试 26 pass / 0 fail（含三轮修复新增 5 条）；server typecheck exit 0。
- OCR：range（073a7d41→91a2dee7）9 findings 中 1 high + 2 medium 已修并复审通过；workspace 修复三轮后 **0 findings**。剩余 low/nit 全部路由 #362。

### 修复轮次（全部 Pi worker TDD，未提交）

1. r1（diff `8ff8633d…`）：`{session}` 非前导标签模板 fail-closed（high）；302 Location 协议相对开放重定向（medium）；dev 端口 80 认领失效（medium）。
2. r2（累计 `a802b931…`）：空基退化模板 `https://{session}./` 逃逸（medium）。
3. r3（累计 `96b8a2b8…`）：probe 哨兵伪造（静态前缀 `probe.`、userinfo 前置）两类逃逸（low，同类收敛：原始模板正则锚定）。

### 移交 #362（在 M-1/M-2/m-5 之上新增）

尾点主机名规范化（含 `x.preview.example.com.` 逃逸 claim）、双点/`{session}` 后 userinfo 模板残余（fail-closed 方向，M-1 一并精确 Host 判别+基域合法性）、准入关闭时签发路由 500→透出 admission reason（m-5 签发侧面）、https 模板 D9 cookie 补 `Secure`、registry 逐出策略（随 M-2）、HMAC 密钥轮换=地址全部重铸（运维文档）、代理不向下游转发 cookie 的测试钉住、routes.ts 可选依赖回退收紧、craft-off 时 dev host 不被 claim 的预期形状确认。
