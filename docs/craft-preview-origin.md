# Craft 预览独立 Origin — 运行行为与已知约束

状态：实现说明（#360–#363 交付轨迹）。行为与验收依据见
`docs/specs/2026-10-15-craft-preview-origin-design.md`（已批准 Spec，D1–D11/AC1–AC9）。
本文回答"部署与运维会撞上什么"，不是第二份 Spec。

## 两种形态

预览必须与主站**不同 HOST**（F2/D1：cookie 只按 host 隔离，换端口无效）。

| 形态 | 地址 | 判别 | 会话定位 |
|---|---|---|---|
| dev（默认） | `http://127.0.0.1:<SERVER_PORT>/<label>` | hostname 恰为 `127.0.0.1`（`localhost` 是主站） | 路径首段 `<label>` |
| 生产 | `<label>.<preview-base>`（模板 `OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE`） | hostname 等于或后缀于 `<preview-base>`（带点边界） | 子域名 `<label>` |

`<label>` = HMAC(keyEncryptionKey, sessionId) 截断 20 个 hex 字符：稳定（地址不漂移）、
不可枚举（猜不出别的会话）、DNS 安全、且**不是** session id 本身（D7/AC9）。

**M-1 隔离前提**（有测试钉死）：主站主机永远不会被当作 preview——后缀匹配带点边界
（`notpreview.example.com` ≠ `preview.example.com` 的子域）、`preview.example.com.evil.com`
不命中、**尾点 FQDN 形式（`x.preview.example.com.`）在匹配前被折叠**（对 DNS 与证书它
就是同一台主机，绝不能因尾点逃逸到主站路由）、dev 形态只认 `127.0.0.1` 精确主机名。
被 preview 命名空间声明的主机**绝不**回落到主站路由：未注册的 label 一律 404。

craft 整体关闭（`OPENBOT_CRAFT_ENABLED=false`）时 preview origin 对象根本不构建：
127.0.0.1/preview 域名不被 claim，请求走主站路由（此时不存在任何预览地址，也没有
webapp-info 面可以给出原因）——这是预期形状，不是退化。

## 进入流程（D4/D9）

1. 主站登录态下 `POST /api/craft/sessions/<id>/preview-ticket` → `{ ticket, expiresAt, origin }`。
   票据：单次使用、30 秒有效，绑定 (userId, sessionId, previewHost) 三元组。
2. 浏览器进入 `origin?ticket=<t>`（票据只出现在这一次跳转的 query 里）。
3. preview origin 校验+消费票据 → 种 preview 域自己的会话 cookie
   （`openbot_preview_session`，HttpOnly、Path=/、SameSite=None; Secure（与 #365
   F-1 实际签发一致）、**无** Max-Age/Expires——浏览器关闭即失效）→ 302 到同地址的干净
   路径（票据从 URL 消失）。
4. 此后该 host 上的一切请求（应用文档、API 调用、Server Actions）凭该 cookie 放行，
   代理到该会话沙箱内的 dev server（附着模型：只探测、不重复拉起）。
   cookie 必须命名**当前 host 的**会话——A 会话的通行证打不开 B 会话的 host。

票据值不出现在任何日志、错误响应或重定向后的 URL（唯一合法出现位置是签发响应体）。

## 已知约束

### M-2 重启空窗（已接受，方案 a）

label→session 的反查表是**内存 registry**：server 重启即清空。已打开的预览标签
reload 会得到 404 "Unknown preview host"，且**不会自愈**——恢复必须经主站重新走票
（预览面板的 webapp-info 轮询或一次新换票都会重新铸址并重新注册 label）。

为什么不落库：反查是必要物（label 是单向哈希，推导不出 session id），但为一条
30 秒票据流买一张 schema 迁移不值——恢复代价是一次点击。多副本部署或运维反馈
"重启丢预览"成为真实痛点时再迁移（见 preview-origin.ts 头注释）。

### 端口语义（PORT/SERVER_PORT 收敛，#360 审阅 Nit 3/4）

dev 形态的端口与 `server/src/config.ts` 的 `serverPort` **同一套规则**（实现收敛在
`preview-ticket.ts` 的 `previewPortFromEnv`）：两个变量必须指同一个数、空值视为未设、
非整数拒绝（`30o1` 不会解析成 30）、不一致即**关闭 preview 准入**并在
webapp-info / 签发路由返回可展示原因——绝不静默偏好某一个。

### 模板（`OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE`）的严格形状

证书与 DNS 要为模板铸出的每一个地址负责，因此形状从严（拒绝即关闭准入并给出命名
变量的理由）：必须纯 ASCII（不支持 IDN）、不得携带 userinfo、主机名不得带尾点、
不得含下划线（非 DNS label 字符）、端口必须是整数、`{session}` 恰好一次且作为主机
名首 label、不得携带路径/query/hash。

### 密钥轮换（运维注意）

预览主机的 label 由 HMAC(keyEncryptionKey, sessionId) 派生：**轮换 key 即全部预览
地址重铸**——已打开的预览标签在旧地址上 404，恢复方式与 M-2 相同（经主站重新进入）。
registry 不做逐出：条目数以会话数为上界，与 M-2 一并接受。

### HMR（#363 的范围）

preview origin 上的 HTTP 代理已就位；websocket 升级（HMR 热更新通道）在 preview
origin 上由 #363 落地。主站同源代理的 HMR 不受影响。

### CSP（`WEBAPP_DEV_CSP`）

`connect-src 'self' ws: wss:` 在 preview origin 下语义正确：`'self'` 就是 preview
origin 自身——应用对自己的 fetch 与 Server Actions 同源可达；`ws:`/`wss:` 保留给
dev server 的 HMR 通道。主站 origin 不在（也不需要在）任何指令里。

## 存量会话（D10 不迁移，#367）

策略已定案（spec D10）：存量 `outputs/web` 继续走旧路径直到自然结束，新会话走新形态。
本节记录判定信号、两种会话各自的行为，以及升级期会撞上的窗口。

### 判定信号：装配代际标记

会话根目录的 `.webapp-generation` 文件（内容 `2`）= **current**（新形态 app）。标记
**缺失**时按 app 是否已装配区分（review-367 H1 修复后的语义）：`outputs/web/package.json`
（与 start 脚本拷贝分支检查的**同一文件**）不存在 = app 未装配 → **current**——首次
`webapp start` 必将拷贝当前磁盘模板并落标记，因此写脚本那一刻就答 current、脚本自带
env，首次构建即挂载-地址一致；package.json 在而标记缺 = 前标记时代装配的存量 app →
**legacy**。标记不可读（gateway 故障等降级读）一律 legacy：无法区分两种缺失人群，
保守向。标记由服务端作者生成的 `start-webapp.sh` 在**模板拷贝进 `outputs/web` 的
那一刻**写入——即 app 代际定格的唯一时刻；已存在的 app 永不重盖。

为什么不是别的信号（票面原建议已过时）：

- **`next.config.ts` 源码是否含 basePath**——F-2（#365 R-6）恢复 env 驱动后，新旧模板
  源码都含 basePath 逻辑（旧版 env 优先 + cwd 回退，新版纯 env），源码含否无法区分。
- **会话创建时间 vs 部署代际**——会话时间 ≠ app 代际：存量会话在部署后重建 webapp 会
  拷贝到新模板（新形态 app），按时间判 legacy 会把可用的新 app 路由到旧路径 → 静默 404。
- **start-webapp.sh 是否含 ONYX_WEBAPP_BASE_PATH 导出**——脚本由服务端在
  provisioning/regenerate 时刷新，反映当前代码而非 app 代际：dev 形态刷新后所有会话
  都含导出（legacy 全部误判 current → 新地址 404），host 形态全部不含（全部误判 legacy）。

不可读一律判 legacy：保守方向落在 D10 要保护的人群上。

### 两种会话的行为

| | legacy（无标记且 app 已装配） | current（标记 `2`，或未装配待诞生） |
|---|---|---|
| `webapp-info` 的 `webapp_url` | 旧同源路径 `/api/craft/sessions/<id>/webapp` | 绝对 preview 地址（D11） |
| `previewOrigin` / 换票 | null / 不换票，iframe 直连旧路径（主站 cookie 鉴权，#359 前行为） | preview 地址 / 单次票据入场 |
| 启动脚本的 basePath 导出 | **不导出**——旧模板的 cwd 回退自动挂载旧前缀（dev/host 两形态都成立） | dev 形态导出 `/<label>`；host 形态不导出 |
| `webappGeneration` 字段 | `"legacy"` | `"current"` |
| HMR | 同源 HMR 分发（升级请求仍按 `/api/craft/sessions/<id>/webapp/_next/webpack-hmr` 解析） | preview origin 的 HMR（#363） |

预览面板对 legacy 会话显示一行双语提示（`preview.legacyNotice`），与本文档口径一致。
旧同源路径的 HTTP 代理与 HMR 分发在新形态下**仍然注册**，这是 D10"走旧路径"的载体；
其同源暴露面是 spec 明确接受的存量代价，随会话自然结束而消失。

### 升级期窗口（均有明确处置，非静默 404）

- **新会话首次构建**（主线路径，review-367 H1 修复后无静默 404）：写脚本时 app 未
  装配（无 `outputs/web`、无标记），判定探 `outputs/web/package.json` 答 **current**，
  脚本从第一次起就带 `/<label>` 挂载 env；首次 `webapp start` 拷贝当前模板、落标记、
  带 env spawn——app 挂 `/<label>`，面板地址与挂载一致，无中间态。（修复前该窗口是
  静默 404：脚本答 legacy 挂根路径，面板读新标记给 `/<label>`，且 staleness-gated
  刷新使新建会话长期无失配、不可自愈。）
- **部署前已启动的 dev server**：以旧脚本启动、无 env → 挂旧前缀，legacy 路径直达可用。
  升级后若该会话被触碰（脚本刷新是 **staleness-gated**：仅当 `opencode.json` 配置字节
  失配——LLM 配置修改或 skills/MCP managed-content 变化——才 regenerate 重写脚本，
  并非任意 turn 无条件发生），新脚本对 legacy 会话仍不导出 env，重启后依旧挂旧前缀——
  两侧一致，无中间态。
- **`OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED=false` 等准入关闭**：新形态无地址（m-5 给
  原因），legacy 会话的旧路径不依赖 preview origin，继续可用；`webapp-info` 对 legacy
  不返回 closed reason（那是新形态地址的事）。
- **存量会话中重建 webapp**：新脚本拷贝新模板即落标记，会话翻转为 current。过渡窗口
  （脚本尚未以 current 形态刷新、或 dev server 未重启）内预览可能短暂不可用。注意
  刷新是 **staleness-gated**（`opencode.json` 字节失配才 regenerate，任意消息本身
  不触发重写）：恢复需要一次真实的配置失配——修改 LLM 配置，或 skills/MCP
  managed-content 变化——触发 regenerate 后对 webapp 执行一次 `restart`；无失配时
  restart 重放的仍是旧形脚本。行为在面板与文档中均可解释，不产生静默 404。
- **标记被 agent 删除**：会话回到 legacy 判定（旧路径 404 时面板可见）。与
  `nextjs.pid` 同信任级别——会话根目录的由服务端管理、agent 无理由触碰的状态文件。

## `webapp-info` 的形状（D11/m-5）

```json
{
  "has_webapp": true,
  "webapp_url": "http://127.0.0.1:3001/<label>",
  "previewOrigin": "http://127.0.0.1:3001/<label>",
  "previewOriginClosedReason": null,
  "webappGeneration": "current",
  "status": "running",
  "ready": true
}
```

- `webapp_url` 是**绝对** preview 地址（D11，已定案；同源代理路径退役）。
- 准入关闭（craft off / 代理 off / origin off / 模板坏 / 端口不一致）时
  `webapp_url` 与 `previewOrigin` 为 null，`previewOriginClosedReason` 携带可展示原因（m-5）。

## 下游核验记录（D11，#362）

| 下游 | 结论 | 证据 |
|---|---|---|
| `preview-tab.tsx` | 已适配：换票 → 单跳入口 → cookie 会话 | `app/src/components/craft/output-panel/preview-tab.tsx` |
| `webapp-download` | 无需改动：自行打包 outputs/web，从不读 `webapp_url` | `server/src/craft/webapp-proxy.ts`（路由体无引用） |
| 桌面端（Tauri） | 无需改动：`desktop/` 全树无 `webapp_url`/`webapp-info`/`previewOrigin` 引用 | `grep -rn "webapp_url|previewOrigin|webapp-info" desktop/` → 0 命中 |
| 分享链路 | 无需改动：craft 的分享面是 `sharingScope`（会话行元数据），没有消费 `webapp_url` 的分享 URL 构造 | `grep -rn sharingScope server/src/craft app/src/lib/craft` |
