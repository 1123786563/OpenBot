# Craft 预览独立 Origin — 运行行为与已知约束

状态：实现说明（#360–#363 交付轨迹）。行为与验收依据见
`docs/specs/2026-10-15-craft-preview-origin-design.md`（已批准 Spec，D1–D11/AC1–AC9）。
本文回答"部署与运维会撞上什么"，不是第二份 Spec。

## 两种形态

预览必须与主站**不同 HOST**（F2/D1：cookie 只按 host 隔离，换端口无效）。

| 形态 | 地址 | 判别 | 会话定位 |
|---|---|---|---|
| dev（默认） | `http://127.0.0.1:<SERVER_PORT>/<label>` | hostname 恰为 `127.0.0.1` 且**路径首段是已注册 label**（`localhost` 是主站） | 路径首段 `<label>` |
| 生产 | `<label>.<preview-base>`（模板 `OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE`） | hostname 等于或后缀于 `<preview-base>`（带点边界） | 子域名 `<label>` |

`<label>` = HMAC(HMAC(keyEncryptionKey, `"craft-preview-label"`), sessionId) 截断 20 个 hex
字符：稳定（地址不漂移）、不可枚举（猜不出别的会话）、DNS 安全、且**不是** session id
本身（D7/AC9）。label 的 MAC key 在用途 label 下从部署密钥两级派生（signed-value 惯例，
`server/src/auth/signed-value.ts`）：一处配置一个密钥，每种用途有自己的材料——预览 label
永远不可能与（或被算作）同一密钥的任何签名/密文用途相混。

**M-1 隔离前提**（有测试钉死）：主站主机永远不会被当作 preview——后缀匹配带点边界
（`notpreview.example.com` ≠ `preview.example.com` 的子域）、`preview.example.com.evil.com`
不命中、**尾点 FQDN 形式（`x.preview.example.com.`）在匹配前被折叠**（对 DNS 与证书它
就是同一台主机，绝不能因尾点逃逸到主站路由）、dev 形态只认 `127.0.0.1` 精确主机名。
被 preview 命名空间声明的主机**绝不**回落到主站路由：host 形态下未注册的 label 一律
404（fail-closed：整个 wildcard 域都是预览命名空间，无主站共存问题）。

**dev 形态认领语义（fix-ocr3 critical）**：dev 形态与安装形态共享同一台主机——安装形态
（`app/serve.ts`）把全部 `/api` 以 `fetch("http://127.0.0.1:<SERVER_PORT>/…")` 转发（Host
头由目标 URL 派生），"主站走 localhost、预览走 127.0.0.1"的两 host 分离假设在那里不成立。
因此 dev 认领 = hostname 恰为 `127.0.0.1`（端口可推导时还需命中 SERVER_PORT）**且路径
首段命中已注册 label**：`/api`、`/` 等未注册首段落回主站路由，安装形态主站不受预览分支
短路；同因 PORT/SERVER_PORT 冲突（端口不可推导）时也不再认领该主机上的一切端口。已注册
label 自己的路径（含 `/<label>/_next/...` 资产与 HMR）照常被认领。重启空窗（M-2）下 dev
形态的旧地址请求同样落回主站路由（而非 404）——恢复路径不变：经主站重新进入即重新注册。

craft 整体关闭（`OPENBOT_CRAFT_ENABLED=false`）时 preview origin 对象根本不构建：
127.0.0.1/preview 域名不被 claim，请求走主站路由（此时不存在任何预览地址，也没有
webapp-info 面可以给出原因）——这是预期形状，不是退化。

## 进入流程（D4/D9）

1. 主站登录态下 `POST /api/craft/sessions/<id>/preview-ticket` → `{ ticket, expiresAt, origin }`。
   票据：单次使用、30 秒有效，绑定 (userId, sessionId, previewHost) 三元组。
2. 浏览器进入 `origin?ticket=<t>`（票据只出现在这一次跳转的 query 里）。
3. preview origin 校验+消费票据 → 种 preview 域自己的会话 cookie
   （`openbot_preview_session`，HttpOnly、Path=host 形态 `/`、dev 形态 `/<label>`（R-9，
   见已知约束）、SameSite=None; Secure（与 #365 F-1 实际签发一致）、**无**
   Max-Age/Expires——浏览器关闭即失效）→ 302 到同地址的干净路径（票据从 URL 消失）。
4. 此后该 host 上的一切请求（应用文档、API 调用、Server Actions）凭该 cookie 放行，
   代理到该会话沙箱内的 dev server（附着模型：只探测、不重复拉起）。
   cookie 必须是**本部署用部署密钥为当前会话签发的** preview pass（`v1.<userId>.<MAC>`，
   #358 修复）：HTTP 与 HMR 共用同一 verifyPass 签名校验，签出的 userId 再经 store 按
   (sessionId, userId) 复核会话行——会话被删除或转移后，旧 pass 立即失效（401/404）。
   A 会话的通行证打不开 B 会话的 host；明文 session id 不是通行证，一律 401。

票据值不出现在任何日志、错误响应或重定向后的 URL（唯一合法出现位置是签发响应体）。

### #358 修复的升级语义（pass 从明文 id 换为签名值）

修复前 preview cookie 的值就是 session id 本身——知道预览地址 + session id 即可伪造凭据。
修复后 cookie 值是部署密钥签发的 pass。**部署新版本后：所有旧 preview cookie（明文 id）
立即被拒（401），不存在兼容旁路**；受影响用户从主站重新进入预览（面板的 webapp-info 轮
询或重新换票都会走完整兑换，种下新 pass）即恢复。不需要迁移旧会话的 webapp 代际（D10 不
受影响），不需要任何数据迁移；pass 无状态、不过期（会话级 cookie，浏览器关闭即消失），
只有“签名密钥 ≠ 当前部署密钥”或“会话行不再属于签发 userId”两种失效方式。

## 已知约束

### 同源防线的部署前提：平台会话 cookie 保持 host-only（fix-ocr26 #7）

预览面板的同源最后防线（`previewOriginBlocked`，比较的是 **hostname**）建立在
一个部署前提上：平台的会话 cookie 全部 **host-only（不携带 Domain 属性）**——
当前代码库全量满足（无任何 Set-Cookie 带 Domain=），因此共罐逃逸只可能是「同
hostname」一种形状，防线据此成立。若某部署（或其反向代理/SSO 层）给平台 cookie
配了 Domain 作用域，子域之间将共享整个 cookie 罐，「仅同 hostname 才是逃逸」的
全称断言失效，hostname 防线不再完整。服务端无法感知平台自身的 cookie 配置，故
只在此记录为部署约束，不做启动不变量。

### dev 形态多预览并存：cookie 按 label 路径隔离（R-9）

dev 形态所有会话共享同一主机 `127.0.0.1:<SERVER_PORT>`：兑换种下的通行证 cookie 若挂
`Path=/`，同名同域同 Path 即同一个浏览器 jar 槽位，后兑换者**覆盖**先兑换者——同时开
两个 dev 预览时，后入场的换票抹掉先入场的通行证，先入场 iframe 的后续请求与 HMR
upgrade 全部 401，且 preview-tab 在 entry 存活期内不重换票，**无法自愈**。因此 dev
形态的 `Set-Cookie` 把 `Path` 挂到本会话的 `/<label>`（与 dev server 的 basePath 挂载
同一推导）：两个会话的 cookie 按路径并存、互不覆盖；浏览器只发匹配 Path 的 cookie，
服务端 `holdsPreviewSessionPass` 取 Cookie 头中**第一个**同名值（RFC 6265 §5.4 按
Path 长度降序发送，第一个即最长 Path——R-9 种在 `/<label>` 的通行证；页面 JS 在父
路径 `Path=/` 种的同名阴影恒排最后不再胜出，否则一次种阴影即跨会话 401 DoS，
fix-ocr5）；HMR upgrade 路径
`/<label>/_next/...` 也在 Path 覆盖内。生产 host 形态一个会话一个主机，无共享，维持
`Path=/`。

### M-2 重启空窗（已接受，方案 a）

label→session 的反查表是**内存 registry**：server 重启即清空。已打开的预览标签
reload：host 形态得到 404 "Unknown preview host"；dev 形态因认领收紧落回主站路由
（旧地址路径不再是已注册首段，fix-ocr3）。两者均**不会自愈**——恢复必须经主站重新走票
（预览面板的 webapp-info 轮询或一次新换票都会重新铸址并重新注册 label）。预览面板的
帧加载探活走**同源**端点 `GET /api/craft/sessions/<id>/preview-origin-live`
（requireUser；204 = 本会话 label 已注册且准入开启；503 = 准入关闭（带可展示原因）或
重启空窗 `{"error":"The preview origin restarted; re-enter the preview."}`；
fix-ocr13）：探针必须同源——跨源 fetch 无 CORS 头时 status 不可读（与网络不可达不可
分），且 dev 形态重启后 registry 为空、旧地址落主站（无 CORS 的 200/404）会误判为
存活。

为什么不落库：反查是必要物（label 是单向哈希，推导不出 session id），但为一条
30 秒票据流买一张 schema 迁移不值——恢复代价是一次点击。多副本部署或运维反馈
"重启丢预览"成为真实痛点时再迁移（见 preview-origin.ts 头注释）。

### 浏览器兼容：Safari/WebKit 拒收明文 http 的 Secure cookie（记录不修）

预览 pass cookie 为 `SameSite=None; Secure`（Chromium 语义必需：跨站 iframe 上下文里
`None` 必须搭配 `Secure`，否则拒收）；而 Safari/WebKit 对明文 `http://127.0.0.1` 的
Secure cookie 拒收——dev 形态在 Safari 下预览不可用，为已知浏览器限制（验收证据链为
Chromium，run6）。无两全属性组合：`None` 需 `Secure` 是 Chromium 语义，
trustworthy-origin 特例是 Chromium 行为，两端不可同时满足，故记录而非修复。

**受支持引擎集合（fix-ocr16 明确）**：dev 形态（明文 http loopback）的可用引擎为
**Chromium 系与 Firefox**——两者均把 loopback（127.0.0.1 / localhost）视为
trustworthy origin，可种下 Secure cookie；**Safari/WebKit 不在支持集合内**——其对
任何明文 http origin（含 loopback）一律拒收 Secure cookie，dev 形态在该引擎下无法
种票、预览不可用。生产形态（https 预览主机）不受影响：Secure cookie 在 https 上
全引擎可种。

### 端口语义（PORT/SERVER_PORT 收敛，#360 审阅 Nit 3/4）

dev 形态的端口与 `server/src/config.ts` 的 `serverPort` **同一套规则**（实现收敛在
`preview-ticket.ts` 的 `previewPortFromEnv`）：两个变量必须指同一个数、空值视为未设、
非整数拒绝（`30o1` 不会解析成 30）、不一致即**关闭 preview 准入**并在
webapp-info / 签发路由返回可展示原因——绝不静默偏好某一个。

### 模板（`OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE`）的严格形状

证书与 DNS 要为模板铸出的每一个地址负责，因此形状从严（拒绝即关闭准入并给出命名
变量的理由）：必须纯 ASCII（不支持 IDN）、不得携带 userinfo、主机名不得带尾点、
不得含下划线（非 DNS label 字符）、端口必须是整数、`{session}` 恰好一次且作为主机
名首 label、不得携带路径/query/hash、scheme 必须是 https（fix-ocr4：预览 cookie 是
SameSite=None; Secure，明文 http origin 上浏览器拒收，http 模板是必 401 的死环；
dev 形态的 `127.0.0.1` 是 trust origin，不受此约束）、基座（`{session}.` 之后的部分）
必须是**多标签域（含 ≥1 个点）或恰好 `localhost`**（fix-ocr5：`{session}.com` 这类
单标签基座会让后缀匹配认领整个公共后缀空间、全站 404，拒绝；
`https://{session}.localhost:3001` 本地测试形态继续放行）。

### 密钥轮换（运维注意）

预览主机的 label 由 HMAC(HMAC(keyEncryptionKey, `"craft-preview-label"`), sessionId) 域分
离派生：**轮换 key 即全部预览地址重铸**——已打开的预览标签在旧地址上 404（host 形态）或
落回主站（dev 形态），恢复方式与 M-2 相同（经主站重新进入）。
#358 修复后 pass 的 MAC 密钥同样从 keyEncryptionKey 按 `"craft-preview-pass"` 用途域分离
派生：轮换 key 还会使全部已签发 pass 失效（验证不过 → 401），用户经主站重新换票即恢复。
两条派生互不可逆推、不可互相伪造（用途域分离）。
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
**legacy**。判定是三态（fix-ocr26 #8）：文件 API 缺失（无沙箱，永久事实）答 legacy；
**读取抛错（gateway 抖动）答 unknown——不是代际裁决**：webapp-info 对 unknown 保持
current 形态答案（webapp_url 不改写，沿用已铸地址），签票路由对 unknown 回 503 +
可重试句子（绝非把抖动折叠成 legacy 的 409 代际事实——那会把 current 会话的地址改写
到 dev server 404 的旧前缀上）；start 脚本写入门对 unknown 按 legacy 处理（不导出挂
载 env），其失配由 webapp-info 的 `.webapp-mount` 交叉检查接住（可修复的显式原因，
而非静默 404）。标记由服务端作者生成的 `start-webapp.sh` 在**模板拷贝进 `outputs/web`
的那
一刻**写入——即 app 代际定格的唯一时刻；已存在的 app 永不重盖。

为什么不是别的信号（票面原建议已过时）：

- **`next.config.ts` 源码是否含 basePath**——F-2（#365 R-6）恢复 env 驱动后，新旧模板
  源码都含 basePath 逻辑（旧版 env 优先 + cwd 回退，新版纯 env），源码含否无法区分。
- **会话创建时间 vs 部署代际**——会话时间 ≠ app 代际：存量会话在部署后重建 webapp 会
  拷贝到新模板（新形态 app），按时间判 legacy 会把可用的新 app 路由到旧路径 → 静默 404。
- **start-webapp.sh 是否含 ONYX_WEBAPP_BASE_PATH 导出**——脚本由服务端在
  provisioning/regenerate 时刷新，反映当前代码而非 app 代际：dev 形态刷新后所有会话
  都含导出（legacy 全部误判 current → 新地址 404），host 形态全部不含（全部误判 legacy）。

读取抛错判 unknown（非 legacy，fix-ocr26 #8）：保守方向从「假装一个代际裁决」改为
「不裁决」——把 current 会话抖动成 legacy 的代价是地址被改写到必然 404 的旧前缀；
unknown 的代价只是多一次重试。

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

签票路由与 `webapp-info` 同读装配代际（fix-ocr24 #5）：直接 POST
`/api/craft/sessions/<id>/preview-ticket` 对 legacy 会话拒签 409（可展示原因、不落任何
票据）——D10 的闭合从面板补齐到 API 面，直接调用拿不到兑换后必然 404 的 preview 地址。

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
- **agent 手工创建 `outputs/web/package.json`**（按 start 脚本的 no-scaffold
  指引自建脚手架）再首次 start 的人群：拷贝分支被跳过、marker 永不落盘，三态判定
  归 legacy——与『marker 被删除』同族的已知残余（会话状态文件的信任级别），预览以
  旧同源路径提供（fix-ocr6）。

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
