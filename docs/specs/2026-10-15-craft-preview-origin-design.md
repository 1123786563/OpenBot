# Craft 预览独立 Origin 设计（隔离生成代码与平台会话）

状态：**已批准**。用户于 2026-10-15 逐条确认 Q1–Q5（Q1 hash、Q2 ACME DNS-01 自动化、Q3 单次使用 + 30 秒 + preview 域会话级 cookie、Q4 不迁移、Q5 `webapp_url` 绝对化）。本文是行为、范围与验收依据，不是实施计划。D1–D6 为实测证据锁定的决定，D7–D11 为本次用户确认的决定；可按 `docs/tickets/craft-preview-origin/` 派发。

来源：2026-10-15 对运行中栈的真实浏览器实测（Chromium + Casdoor 登录 + server :3001 + 沙箱内 dev server），以及本仓库源码只读核验。领域术语见根 `CONTEXT.md`。

## 发布记录

用户于 2026-10-15 授权发布：父 Spec 为 [358](https://github.com/1123786563/OpenBot/issues/358)，实施 Tickets 为 #359–#367（9 张），均带 `ready-for-agent` 标签，父 Issue 任务清单以真实编号表达 blocked-by 依赖。本地正文与远端一致。

## 已核验事实（2026-10-15，真实栈实测）

craft 的 webapp 预览目前与主站**同源**：`app/src/lib/craft/client.ts` 全部走相对路径 `/api/craft/...`，dev 由 vite 把 `/api` 代理到 :3001，生产由 server 直接服务应用 HTML 并应答 `/api/**`。认证是 **cookie**（`app/src/lib/client.ts:170` 发送 `credentials: "include"`）。

预览 iframe 带 `sandbox="allow-scripts allow-same-origin ..."`（app/src/components/craft/output-panel/preview-tab.tsx）。在同一 origin 上，`allow-same-origin` 意味着 LLM 生成的代码可以以登录用户身份调用平台 API。浏览器自身也告警这一点：`An iframe which has both allow-scripts and allow-same-origin for its sandbox attribute can escape its sandboxing.`

登录态下对三个候选 origin 的实测（同一浏览器上下文，主站密钥写入 localStorage、并植入一个可见 cookie）：

| 候选 preview origin | 读到主站 localStorage | `document.cookie` 可见主站 cookie | 带凭证调 `:3010/api/craft/sessions` |
|---|---|---|---|
| `localhost:3010`（现状，同源） | **读到** | **6 个全可见** | **HTTP 200，响应可读** |
| `localhost:3001`（只换端口） | 隔离 | **6 个全可见** | **HTTP 200，响应可读** |
| `127.0.0.1:3001`（换主机） | 隔离 | **空** | **401** |

结论（实测，非推断）：

- **F1 cookie 不按端口隔离**，只按 host+path。因此"换端口的独立 origin"是假独立：DOM/localStorage 隔离生效，但生成代码仍可骑用户会话调平台 API。写操作甚至不需要读到响应。
- **F2 只有换主机才真正隔离** cookie 与会话。
- **F3 `allow-same-origin` 不能摘**：摘掉后 iframe 变 opaque origin，应用自己的 `fetch` 到自身 API 变成跨源且无 CORS 头可读，`localStorage`/`indexedDB` 抛 SecurityError —— 预览会从"能渲染"退化成"完全不可交互"。所以正确方向是换 origin 而不是收紧 sandbox 属性。

## 附带发现的第二类问题：basePath 足枪

脚手架把 `basePath` 设成 `/api/craft/sessions/<id>/webapp`（`server/assets/craft/web-template/next.config.ts`），否则资源 URL 逃逸到宿主 origin、iframe 永不 hydrate。但 Next.js 只给 `<Link>`、`router.push` 和资源加前缀，**不给裸 `fetch()` 加**。而文档 URL 是 `/…/webapp`（无尾斜杠）。

实测（冷启动 dev server + curl，及真实浏览器三按钮对照）：

- `fetch(apiUrl("/api/probe"))`（`@/lib/base-path` 包装）→ **200**，到达应用自己的 route handler
- `fetch("/api/probe")`（根绝对）→ **404**，请求落在**宿主产品**的 `/api/**` 命名空间，且带用户 cookie —— 命中任何真实存在的平台路由即构成数据泄露（如 `/api/craft/sessions`）
- `fetch("api/probe")`（相对）→ 404，`webapp` 段被吃掉

注：在一次热编译窗口内三种写法曾同时返回 200，冷启动后行为恢复为上表。即该行为**不可依赖**，这正是必须给 agent 明确 API 的原因。

## 目标与范围

**目标**

1. 生成的预览应用与平台会话在浏览器层隔离：生成代码无法以登录用户身份读写平台 API。
2. 生成代码调用自身 API 的方式有且只有一条正确路径，且该路径被脚手架与 AGENTS.md 明确支持。
3. 会话之间互相隔离：会话 A 的预览不能触及会话 B 的预览资源。
4. 预览保持完全可交互（已有能力不回退：hydration、HMR 热更新、POST/PUT/PATCH/DELETE 透传、全屏放大）。

**非目标**

- 不解决生成代码的任意外呼（它能 `fetch` 任意公网地址并外带它读到的数据）。那是网络出站沙箱问题，独立立项。
- 不改变 webapp 工具、`start-webapp.sh`、端口预留与预览代理的"附着不重复拉起"模型。
- 不处理生产 TLS 证书的申请与续期自动化（作为 Ticket 的前置核验项列出，由部署方提供）。

## 已确认决定（由实测证据锁定）

- **D1 采用换主机的独立 preview origin**。只换端口被实测证伪（F1），摘 `allow-same-origin` 被实测证伪（F3）。
- **D2 保留 `allow-same-origin`**。换主机后它指向 preview 自身 origin：应用拿到完整的 storage / 同源 fetch / Server Actions，而主站 cookie 不在作用域内。预览域上的 cookie 只对预览有效。
- **D3 采用每会话子域名**（`<session>.<preview-host>`），不用共享 preview origin + 原路径。理由：a) 原路径形态下 basePath 足枪原样保留；b) 共享 origin 下会话 A 可 fetch 会话 B 的预览资源（跨会话问题）。每会话子域名让应用跑在根路径，basePath 机制整体退场。
- **D4 鉴权用短时一次性 preview ticket**，不做跨域 cookie 共享。主站 cookie 换票 → 302 到干净路径时在 preview 域种 HttpOnly cookie；HMR 升级同票校验。
- **D5 dev 环境默认 `127.0.0.1:<SERVER_PORT>` 作为 preview origin**，不需要泛域名 DNS（实测 C 行证明 `127.0.0.1` 与 `localhost` 即为不同主机、隔离生效）。`localhost` 上登录的会话 cookie 不会泄漏到 `127.0.0.1` 的 preview。
- **D6 basePath 机制在形态 2 下整体退场**：脚手架的 `resolveWebappBasePath()`（靠 `process.cwd()` 正则抠 session id）、`assetPrefix`、`redirects` 的 `/` 兜底全部删除；`lib/base-path.ts` 退化为常量空串（保留导出以免破坏已生成的应用，第一步已交付）。

  > **修订 2026-10-16（R-6，final-review F-2）**：#365 实测发现 dev 形态（127.0.0.1 路径 label，D5）下应用资源 URL 仍需 `/<label>` 前缀，纯空串退场导致预览页 404 不 hydrate。裁决为**显式 env basePath**：服务端生成的 start 脚本注入 `ONYX_WEBAPP_BASE_PATH`/`NEXT_PUBLIC_BASE_PATH`，`next.config.ts` 读 env（trim 非空才设 basePath/assetPrefix，空/未设即根路径=生产 host 形态不变），`lib/base-path.ts` 读 `NEXT_PUBLIC_BASE_PATH`。**cwd 正则推导与 `/` 兜底 redirects 维持退场**（env 由受控启动方注入，非进程位置猜测）；代理转发 dev 形态完整路径（不剥 label）。裁决记录：执行 Ledger §11 R-6；实现与测试见 #365 F-2 修复。

## 已确认决定（2026-10-15，用户逐条确认）

- **D7（Q1）子域名用 hash，不用明文 session id**。避免把内部标识写进 DNS 记录与证书透明度日志。派生必须稳定（会话存活期间预览地址不漂移）、不可枚举（不能由他人猜出其它会话的预览主机）、DNS 标签安全（≤63 字符），且服务端可反查到会话。具体机制（HMAC 截断 + 存储映射列，或其他）由 Ticket 02 选定，Spec 只锁要求。
- **D8（Q2）泛域名证书用 ACME DNS-01 自动化**。签发与续期必须是自动流水线，不是一次性人工操作 —— 这是一条真实工作项（Ticket 00），不是部署前置核验。dev 形态（`127.0.0.1`）不需要证书，不受此阻塞。
- **D9（Q3）preview ticket 单次使用 + 30 秒有效期**；兑换成功后在 preview 域种**会话级**（无 Max-Age/Expires）HttpOnly cookie，浏览器关闭即失效。不做“预览空闲 N 分钟后作废”。
- **D10（Q4）存量会话不迁移**。存量 `outputs/web` 继续走旧路径直到自然结束，新会话走新形态；判定信号由 Ticket 08 落地并文档化。
- **D11（Q5）`webapp_url` 绝对化**。`webapp-info` 返回含 preview 主机的绝对地址。下游必须逐一核验并适配：`preview-tab.tsx`、`webapp-download`、桌面端（Tauri）、分享链路。绝对地址是确认的行为，不是兼容性事故。

## 修订轨迹（原待确认问题，2026-10-15 提出并当轮确认）

原 Q1 子域名形态、Q2 证书来源、Q3 ticket TTL、Q4 存量迁移、Q5 `webapp_url` 形状 —— 均已按上文 D7–D11 定案，此节保留作为决策轨迹。

## 验收标准

- **AC1** 在 preview origin 上，生成代码执行 `fetch("http://<主站origin>/api/craft/sessions", {credentials:"include"})` 得到 **401**，`document.cookie` 不含主站 cookie，`localStorage` 为独立空库。（对应 F1/F2/D1/D2）
- **AC2** 同一生成的应用，其自身 API 调用（POST/PUT/PATCH/DELETE）全部 200 且读写到自己的 route handler；Server Actions 可用。（对应 D2，保证不回退交互能力）
- **AC3** 会话 A 的预览内 `fetch` 会话 B 的预览任意路径 → 404 或拒绝，无法读写 B 的文件。（对应 D3）
- **AC4** 预览加载需要有效 ticket：无票、过期票、已用票、他人会话的票一律拒绝；票据单次使用。（对应 D4）
- **AC5** `webapp tool` 的 `status`/`logs`/`restart` 与预览指向同一 dev server 进程（附着模型不回退），HMR 热更新在新 origin 下仍然工作。（回归保护）
- **AC6** 生产形态：无泛域名证书/未配置 preview 域名时，功能准入显式关闭并给出可展示原因，不静默回退到同源形态。（对应 Q2/D8）
- **AC7** 存量会话行为不回归：按 Q4/D10 结论，旧会话的预览仍可用或明确给出不可用原因。（对应 Q4/D10）
- **AC8** 生产 preview origin 的泛域名证书由 ACME DNS-01 自动签发与续期：首次签发无需人工，续期在到期前自动完成，续期失败可观测并告警。（对应 D8）
- **AC9** 预览主机名不泄露会话标识：任何子域名都不是 session id 本身或其可直接解码形式，且无法通过枚举子域名发现其它会话。（对应 D7）

## 实施前置核验

- Bun 的 `serve()` 单进程多 hostname 路由：preview origin 与主站 origin 是否由**同一进程同一端口**承载（靠 Host 头分发），还是需要第二端口。前者部署最简，需确认 Bun 能在同一 listener 上按 Host 分流 upgrade 与 HTTP。
- D7 的 hash 反查机制：映射存放在会话行新增列还是服务端 KV，由 Ticket 02 选定，不影响对外形状。
- 生成代码的 CSP 需要按新 origin 重算（`connect-src 'self'` 在 preview origin 下语义变化）。
- ACME DNS-01 所需的 DNS 提供商凭据与 API 权限（Ticket 00 的前置输入，由部署方提供）。
- 桌面端（Tauri）与分享链路若引用 `webapp_url`，需确认绝对地址的接受度（D11，Ticket 03 核验）。
