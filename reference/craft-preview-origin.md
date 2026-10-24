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
   cookie 必须是**本部署为当前会话签发的** preview pass（`v1.<随机 token>.<MAC>`，
   #358 修复 + #427 轮换）：值是每次兑换新鲜铸出的 128 位随机 token，MAC 只覆盖版本与
   token（不覆盖 sessionId，cookie 里也不出现 session id）；token → (sessionId, userId)
   的绑定在**服务端索引**（`server/src/craft/preview-pass.ts` 的 `PreviewPassIndex`）。
   HTTP 与 HMR 共用同一 `verifyPass` 判定：MAC 不过 ⇒ 401；MAC 过但索引查不到 ⇒ 也是
   401（没有「查不到索引就放行」的路径）；索引命中的 sessionId 还必须等于本 host 解析
   出的会话。签出的 userId 再经 store 按 (sessionId, userId) 复核会话行——会话被删除或
   转移后，旧 pass 立即失效（401/404）。A 会话的通行证打不开 B 会话的 host；明文
   session id 不是通行证，一律 401。

票据值不出现在任何日志、错误响应或重定向后的 URL（唯一合法出现位置是签发响应体）。
签发响应与兑换 302 均带 `Cache-Control: no-store` + `Referrer-Policy: no-referrer`（#406）。
**部署注意（#406）**：票据唯一出现在浏览器进入 `origin?ticket=<t>` 那一次跳转的 query 里，
而这一跳经过反向代理（含 TLS 终结者）——默认访问日志按原样记录完整 query，票据值会落盘。
反代必须对 `?ticket=` 脱敏（nginx：`log_format` 用 `$uri` 代替 `$request`，或 map 掩码
该 query），否则上句「不出现在任何日志」在部署层不成立。

### #358 修复的升级语义（pass 从明文 id 换为签名值）

修复前 preview cookie 的值就是 session id 本身——知道预览地址 + session id 即可伪造凭据。
修复后 cookie 值是部署密钥签发的 pass。**部署新版本后：所有旧 preview cookie（明文 id）
立即被拒（401），不存在兼容旁路**；受影响用户从主站重新进入预览（面板的 webapp-info 轮
询或重新换票都会走完整兑换，种下新 pass）即恢复。不需要迁移旧会话的 webapp 代际（D10 不
受影响），不需要任何数据迁移；pass 不过期（会话级 cookie，浏览器关闭即消失），
只有“签名密钥 ≠ 当前部署密钥”、**“token 不在本进程索引里（重启 / 已作废）”**或“会话行
不再属于签发 userId”三种失效方式。

#427 再次换了内核（不变外层）：值从确定性签名变为**随机 token + 服务端索引**。上线后，
旧版 stateless pass 的 token 槽位是一个 userId 的 base64url（长度不是 16 字节），在严格
解析第一步即被拒——同样是 401 后经主站重新换票恢复，没有兼容分支、没有数据迁移。

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
同一推导）：两个会话的 cookie 按路径并存、互不覆盖；浏览器只发匹配 Path 的 cookie。

服务端判定（2026-10-18 按代码更正，#419）：`verifyPassWith`
（`server/src/craft/preview-origin.ts:104`）**遍历 Cookie 头里全部同名候选，任一验签
通过即放行**（fix-ocr20 #3；#427 起「验签通过」包含索引命中，阴影里的伪造值仍然过不了
MAC 也过不了索引）。早期写法是「取第一个同名值」并断言父路径 `Path=/` 的
同名阴影恒排最后（fix-ocr5）——该断言不成立：RFC 6265 §5.4 按 Path 长度**降序**发送，
而 HttpOnly 只保护通行证自己那条 name+domain+path 槽位，页面 JS 在更深路径
（如 `Path=/<labelB>/x`）种同名候选完全合法，于是阴影排在最前，只判首值即被遮住，一次
种阴影就能把会话 B 的整个预览打成 401（跨会话 DoS）。遍历全部候选后，阴影遮不住罐子里
真实存在的通行证；罐子里没有通过验签的候选仍然拒绝。旧函数名
`holdsPreviewSessionPass` 及其「cookie 值 == sessionId」的比较已随 #358 修复删除，
通行证必须是本部署为该会话签发且索引仍在的 pass（#427：随机 token + 服务端索引）。

HMR upgrade 路径 `/<label>/_next/...` 也在 Path 覆盖内。生产 host 形态一个会话一个
主机，无共享，维持 `Path=/`。

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

### 通行证索引与单 token 作废（#427）

#427 把通行证的内核改为**每次兑换新鲜铸出的 128 位随机 token**，并新增
token → (sessionId, userId) 的服务端索引（`createPreviewPassIndex` /
`PreviewPassCodec.revoke`，经 `PreviewOrigin.revokePass` 暴露给服务端调用面）。
索引与 label registry、票据表同属**进程内状态**（#418 单副本契约）：多副本部署需要
sticky 路由或共享存储，启动日志的 single-replica 通知覆盖这一族。

- **生命周期与重启**：索引随进程重启清空，MAC 仍能通过的存量 token 查不到 ⇒ 401。
  恢复与 M-2 相同——经主站重新进入（webapp-info 轮询或新换票都会重新兑换并种下新
  token）。D9 的 cookie 是会话级的：浏览器关闭即丢弃 cookie，但服务端看不到这个
  事件，索引条目会留到重启或显式作废（与 registry 不做逐出同一取舍，条目数按兑换
  次数计而非会话数）。
- **单 token 作废（AC7）**：删除一个索引条目即可让**那一个**通行证 401，会话本身与
  同一会话的其他 token 不受影响；再次铸票立即可用。作废按 (sessionId, 候选值) 双重
  校验——传错会话 id 不会误删别人的 token；候选值先过与 verify 相同的**形状**门
  （mac 字符集、token 严格解码与 16 字节长度，N4-01），MAC 本身在作废时不复验——撤销的
  权威是索引命中与会话绑定，不是签名。全局密钥/版本轮换仍是更粗的上一层。
  本票只交付导出 API 与测试覆盖，尚无生产调用方（调用面是后续会话删除/强制退出
  钩子的接缝）。
- **fail-safe 同形**：空值、未知 token、已作废 token、别的部署铸出的 token 全部 401
  ——判定是「MAC 通过 **且** 索引命中本会话」，不存在「查不到就放行」。

### 多副本契约：单副本或 sticky 路由，否则跨实例 404（#418，Option B）

同一份进程内状态（label registry 与 preview ticket 表）在多副本/负载均衡下的另一个
代价：**签票落在副本 A，兑换落在副本 B** 时，B 的 registry 从未见过该 label，请求
得到 404 "Unknown preview host."，与重启空窗（M-2）同形，但**不会自愈**——会话没有
重启，重新走票也会被负载均衡再次分到别的副本。Redis（若配了）救不了它：registry
与 ticket 表都不在 Redis 里，Redis 只服务 workshop 域的锁与总线。

部署形态因此是二选一，显式写在启动日志里：

- **单副本**：本服务当前支持的目标形态（D-4：仅在生产要求 HA 时再做共享存储）。
- **多副本 + sticky 路由**：负载均衡器必须把同一预览会话的流量固定到同一实例
 （host 形态按 `<label>.<preview-base>` 子域哈希分发即可，dev 形态按源 IP）。没有
 sticky 的多副本不在支持范围内。

启动检查（#418）：preview origin 开启时，启动日志必打一条
`single-replica contract: the preview origin's label registry and ticket table are in-process …`
（info 级）；当检测到 `OPENBOT_REDIS_URL` 已设（部署自己的多副本信号，与 workshop
域读同一个变量）而 registry 仍是进程内状态时，升为 **warn** 并点名 sticky 路由。
craft 关闭或 preview origin 关闭时不打——关闭的 origin 没有 preview host 可路由错。

可观测信号：preview origin 暴露 `registryStats()`（返回
`{"registeredLabels": N}`，只计数，永不枚举 label 或 session id，AC9）。健康检查/
日志采集器可用「活跃预览存在但本实例 registeredLabels=0」这一形状定位多副本路由
切错的实例——这是 Option B 代替共享存储的观测面：不修 404，但让 404 可被归因。

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

### 基座必须是独立子域：主站 host 落在模板基座下即关闭准入（#404，AC6/M-1）

host 形态的认领规则是「基座本身 + 基座下的一切」（`claimsPreviewHost`，端口无关），
所以 `https://{session}.example.com` 会连 `example.com` 与 `app.example.com` 一起
认领：主站自己的 host 落在模板基座里时，它的每个请求都走进 preview 分支并 404
“Unknown preview host”，没有任何主站路由可达 —— 配错一行，整站下线。

判据不另写一套：准入用 dispatcher 的**同一个谓词**去量 `config.appUrl` 解析出的
host（`server/src/index.ts` 注入；`appUrl` 链路是 `OPENBOT_APP_URL` →
`TRUSTED_ORIGINS` 首项 → `OPENBOT_PUBLIC_URL`）。重叠即 **closed**，理由可展示且
同时命名基座、被吞掉的主站 host 与改法；`originFor` 抛错 ⇒ 不存在任何预览地址，
绝不回退同源形态（AC6）。尾点 FQDN、大小写、userinfo、无 scheme 的写法（按 https
默认端口读）与 dispatcher 的判定结果一致；`appUrl` 未设置或解析不出 host 时**不判
定** —— 这道闸只拒绝「已证明的宕机」，不猜测读不懂的配置。

`localhost` 基座继承 fix-ocr22 #2 的两条收窄，既不放过也不误杀：裸 apex 从不被认领
（本地主站就住在 `localhost` 上），认领必须落在模板自己的端口上。因此
`http://localhost:3001` 主站 + `https://{session}.localhost:3001` 仍是 open，而
`http://app.localhost:3001` 配同一模板是 closed。

ACME sidecar 做同样校验（`docker/compose/certs/lib.sh` 的 `main_site_hostport` 与
`derive_preview_host`）：命中重叠时以 `invalid|…` 拒绝启动，理由进 `docker logs` 与
renewal-status.json，不再为一个服务端已经拒绝的基座烧 LE 签发配额。这一侧只读链路
的**起点** `OPENBOT_APP_URL`（由 `docker/compose/certs.yml` 透传），未设置就完全不判
定 —— 不重新实现服务端的 fallback 链：猜错主站会把一个服务端跑得好的配置拒死，
服务端才是唯一权威。两侧黄金用例互相指名：`server/tests/craft-preview-origin.test.ts`
的「#404: a preview base that swallows the main site's host closes admission」与
`scripts/tls-pipeline.test.ts` 的「derive_preview_host: a base that swallows the main
site is refused (#404)」；改任一侧的判据必须同时改另一侧。

### 密钥轮换（运维注意）

预览主机的 label 由 HMAC(HMAC(keyEncryptionKey, `"craft-preview-label"`), sessionId) 域分
离派生：**轮换 key 即全部预览地址重铸**——已打开的预览标签在旧地址上 404（host 形态）或
落回主站（dev 形态），恢复方式与 M-2 相同（经主站重新进入）。
#358 修复后 pass 的 MAC 密钥同样从 keyEncryptionKey 按 `"craft-preview-pass"` 用途域分离
派生：轮换 key 还会使全部已签发 pass 失效（验证不过 → 401），用户经主站重新换票即恢复。
这是**全局**层级；#427 的单 token 作废（`revokePass`，删索引条目）是更细的层级——只退掉
一个通行证而不动会话与其他 token。两层并存：日常轮换用单 token 作废，密钥轮换是全量重置。
两条派生互不可逆推、不可互相伪造（用途域分离）。
registry 不做逐出：条目数以会话数为上界，与 M-2 一并接受；pass 索引不做逐出，见
「通行证索引与单 token 作废」一节。

### HMR（#363，代码已落地）

preview origin 的 HTTP 代理与 websocket 升级通道都已实现：升级判定入口
`resolvePreviewWebappHmrUpgrade`（`server/src/craft/webapp-proxy.ts:1298`），与 HTTP 门
共用同一个 `verifyPassWith` 验签（`server/src/craft/preview-origin.ts:104`），并额外带
Origin 门（fix-ocr28 #1：WebSocket 握手不受 CORS 约束，而通行证 cookie 是
`SameSite=None`，不校验 Origin 就等于把活着的 HMR 通道送给任意站点）。主站同源代理的
HMR 不受影响。

**证据边界（2026-10-18 更正，#419）**：本节只主张「接线与单测存在」，属静态核验。AC5
要求的是真实 dev server 在新 origin 下 DOM 热更新仍然工作，这条**没有运行时证据**：
#437（新会话 start 脚本未注入 `/<label>` mount，预览恒 404）与 #436（干净库 migrate 后
启动即 `42703`）两张 P0 仍 OPEN，dev 形态端到端起不来，热更新无法实测。不要把本节读作
AC5 已通过。

### CSP（`WEBAPP_DEV_CSP`）

`connect-src 'self' ws: wss:` 在 preview origin 下语义正确：`'self'` 就是 preview
origin 自身——应用对自己的 fetch 与 Server Actions 同源可达；`ws:`/`wss:` 保留给
dev server 的 HMR 通道。主站 origin 不在（也不需要在）任何指令里。

`form-action 'self'` 与 `frame-src 'self'`（codex 重审 F-1）把 `connect-src` 覆盖
不到的两条 reach-back 通道一并钉住：预览 host 与主站同 eTLD+1，SameSite 按 site
判定，未约束的表单 POST 会携带主站会话 cookie（`connect-src` 不约束表单提交）；
嵌套主站 iframe 属同类通道（带 cookie 的活文档 + UI 遮挡面）。顶层自导航
（`location.href` 指向主站写 GET）无已发布的 CSP 指令可约束（`navigate-to` 已从
CSP3 移除），由「主站不在 GET 上变更状态」兜底。

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
| HMR | 同源 HMR 分发（升级请求仍按 `/api/craft/sessions/<id>/webapp/_next/webpack-hmr` 解析） | preview origin 的 HMR（#363 代码已落地；运行时热更新仍待实测，受 #437 阻塞） |

预览面板对 legacy 会话显示一行双语提示（`preview.legacyNotice`），与本文档口径一致：
提示同时说明**风险**（该预览与平台同源，生成的代码可以用你的会话访问平台 API）与
**收敛办法**（重建 web app 迁移到隔离预览源）。
旧同源路径的 HTTP 代理与 HMR 分发在新形态下**仍然注册**，这是 D10"走旧路径"的载体；
其同源暴露面是 spec 明确接受的存量代价，随会话自然结束而消失。

### 部署级开关与风险收口（#425，AC1 例外的关闭面）

**风险**：legacy 形态下 iframe 指向的是主站自己的同源路径，携带平台 cookie——
`WEBAPP_DEV_CSP` 的 `connect-src 'self'` 中 `'self'` 就是主站 origin，因此生成的代码
可以以登录用户身份读写平台 API。这正是 #358 要修的暴露，D10 只是对存量会话暂缓。

**开关**：`OPENBOT_CRAFT_LEGACY_PREVIEW_ENABLED`（`boolEnv` 语义：`true`/`false`/
`1`/`0`/`yes`/`no`/`on`/`off`）。**默认 `true`**——直接默认关闭会让所有存量会话的预览
在升级当场不可用（AC7 的"存量不回归"优先）；本开关的目的是给部署方选择权，不是替
所有部署做决定。关闭后四个面同时收口：

| 面 | 关闭后的行为 |
|---|---|
| `webapp-info` | legacy 分支答 `webapp_url: null` + 可展示关闭原因（`previewOriginClosedReason`，复用既有关闭通道），`webappGeneration` 仍如实 `"legacy"` |
| 同源 HTTP 代理 | 两处 `proxyWebapp` 注册对 legacy 会话答 503 + 同一原因句；判定在鉴权与属主检查之后（401/404 语义不变，开关不泄露会话存在性）、在就绪探针之前（被拒请求不拨上游） |
| 同源 HMR 升级 | `resolveWebappHmrUpgrade` 以同一判定在 `server.upgrade` 提交前拒绝（503） |
| 换票 | **不变**：legacy 仍 409（`PREVIEW_TICKET_LEGACY_ERROR`），unknown 仍 503 可重试——开关不是票据语义 |

判定与 HTTP/HMR 两腿镜像（`legacyPreviewSwitchedOffFor`）：仅读代际裁决，且只在开关
关闭时才读（默认部署零额外开销）；`unknown`（读取抖动）也拒绝——同源路由的合法流量
只有 legacy 人群（current 会话的面板走 preview origin、HMR 走 origin 自己的分发器），
让抖动把门撑开会使开关的承诺取决于 gateway 天气。**已修复人群不受影响**：挂载记录
能证明 current 挂载的会话（fix-ocr27 #3 的手工装配修复分支）在开关关闭时仍走新形态。

**收敛办法**：重建 web app（让 agent 重新 `webapp start`/重新生成会话）——模板拷贝
写入 `.webapp-generation` 标记（见上文判定信号），装配即翻转为 current，随后走隔离
预览源；判定信号的三态语义（legacy/current/unknown）见 `webapp-generation.ts`。

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
  失配——LLM 配置修改或 skills/MCP managed-content 变化——或（#437 修复）**磁盘上的
  start 脚本与当前派生不等**——才 regenerate 重写脚本，并非任意 turn 无条件发生），新
  脚本对 legacy 会话仍不导出 env，重启后依旧挂旧前缀——两侧一致，无中间态。
- **生产部署空模板（#408 AC6）**：`OPENBOT_APP_URL` 指向非 loopback 主机而
  `OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE` 为空时，准入显式关闭——`webapp-info` 无地址、
  给出可展示原因，`preview-ticket` 拒绝出票。dev 形态的 `127.0.0.1:<port>/<label>` 地址
  对远程浏览器指向其自身 loopback，按构造不可达；loopback/未设 `OPENBOT_APP_URL` 的本地
  部署不受影响，保持 dev 形态。
- **`OPENBOT_CRAFT_PREVIEW_ORIGIN_ENABLED=false` 等准入关闭**：新形态无地址（m-5 给
  原因），legacy 会话的旧路径不依赖 preview origin，继续可用；`webapp-info` 对 legacy
  不返回 closed reason（那是新形态地址的事）。
- **存量会话中重建 webapp**：新脚本拷贝新模板即落标记，会话翻转为 current。过渡窗口
  （脚本尚未以 current 形态刷新、或 dev server 未重启）内预览可能短暂不可用。注意
  刷新是 **staleness-gated**（`opencode.json` 字节失配，或 #437 修复加入的
  「磁盘脚本与当前派生不等」判定，才 regenerate；任意消息本身不触发重写）：恢复走
  `POST /sessions/<id>/skills/reload`——它对 up-to-date 会话在脚本失配时也会强制
  regenerate 重写脚本，随后对 webapp 执行一次 `restart` 让挂载记录跟上；重写后无
  失配时 restart 重放的仍是（已正确的）现行脚本。行为在面板与文档中均可解释，不产
  生静默 404。
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

## #358 修复期裁决提案（待批准，批准前不作为验收依据）

以下两条是与批准 Spec 原文有出入的表述修正提案，按修复计划 Task 4 提出，
**批准前**相关验收结论保持 `partial`，不标 `verified`：

1. **D6（basePath 退场）建议表述为**："生产 hash Host 在根路径；dev 默认
   `127.0.0.1/<label>` 由显式 env（`ONYX_WEBAPP_BASE_PATH`/`NEXT_PUBLIC_BASE_PATH`，
   受控启动方注入）挂载；禁止 cwd 猜测"。原文 R-6 修订已含此义，但 D6 正文
   仍是"整体退场"的旧句 —— 建议把 R-6 的 env 挂载并入 D6 正文，消除两处表述
   差异。影响面：纯表述；实现（env 注入 + cwd 推导退场）不变。
2. **AC1（协议层 401）建议区分两层**："浏览器侧：生成代码 fetch 主站 API 受
   CSP 拦截或得到未认证响应，`document.cookie`/`localStorage` 隔离"与"服务端
   协议层：来自 preview origin 的同形请求为 401"。原文只写浏览器观测
   （fetch 得到 401），而 Chromium 对跨源 fetch 常以 CSP 拒绝（网络层不可见），
   协议层 401 只能用顶层面板或 curl 形状复现。建议 AC1 明确两层各自可接受
   的证据形状。影响面：验收证据的判读方式；行为不变（两层都已由本 SHA 的
   单元与真实栈证据覆盖）。

## 可复跑全栈 e2e（#416）

验收脚本 `scripts/craft-preview-acceptance.ts` 支持两种拓扑 profile，用
`CRAFT_ACCEPTANCE_TOPOLOGY` 选择（非法值 fail-fast，不静默回退）：

| profile | 值 | 形态 | AC1 same-site 步骤 |
| --- | --- | --- | --- |
| dev（默认） | `dev` | 跨站拓扑，预览在 `http://127.0.0.1:<API 端口>/<label>` | SKIP（跨站 SameSite=Lax 不随行；dev form 的 Origin 不可识别是 #410 已知缺口） |
| same-site | `same-site` | 生产形态，预览是主站子域（同 eTLD+1） | pass 类断言：预览页同 site 凭证写主站 → #410 origin-guard 403（server 日志增量归因 `verdict:"preview"`） |

### 运行入口

- `bun run test:live-craft-preview`：原入口（环境预检 app :3220 / API :3221
  → 脚本 preflight 含 Casdoor :8000 / sandbox gateway :4300）。
- `bun run test:craft-preview-e2e`（#416）：拓扑感知入口——校验
  `CRAFT_ACCEPTANCE_TOPOLOGY` 与 `CRAFT_ACCEPTANCE_PREVIEW_ORIGIN`（same-site
  必填，如 `https://preview.localhost`）后转入同一 live 预检。

### same-site profile 的部署前置

1. host-form server：`OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE=https://{session}.preview.localhost`
   （`*.preview.localhost` 与 `localhost` 都解析到 127.0.0.1，无需 wildcard DNS）；
   TLS 准入走 `OPENBOT_TLS_STATUS_FILE` 指向的状态文件（health 标量 `ok` 即开门，
   本地签发写 `{"health":"ok"}` 即可）。
2. #412 参考 TLS 终止（`docker/compose/preview-tls.yml`）：
   `OPENBOT_PREVIEW_UPSTREAM=http://host.docker.internal:<server 端口>`，443 终止
   并注入 `X-Forwarded-Proto: https`（通行证 cookie 是 `SameSite=None; Secure`，
   需要 https 形态）。
3. 主站与预览同 443（如 `https://localhost` 与 `https://<label>.preview.localhost`），
   Chrome/Playwright 信任 localhost 族的自签形态。
4. `CRAFT_ACCEPTANCE_SERVER_LOG` 指向 API server stdout 日志（AC1 协议层与
   same-site 步骤的判决增量归因都读它）。

### 拓扑差异的断言口径（脚本内同一事实源派生）

- 地址形状：`expectOrigin(label)`（host：`https://<label>.<base>`；dev：
  `http://127.0.0.1:<port>/<label>`）；label 永远从服务器铸造的 `webapp_url`
  提取，不在脚本侧重算 HMAC。
- 应用路径前缀：`appPrefix(label)`（host：根路径无前缀；dev：`/<label>`）。
- 通行证 jar domain：`previewCookieDomain(label)`（host：`<label>.<base host>`；
  dev：`127.0.0.1`）。
- HMR socket：`hmrWsUrl(label)`（host：`wss://<label>.<base>/_next/webpack-hmr`；
  dev：`ws://127.0.0.1:<port>/<label>/_next/webpack-hmr`）。
- preflight 的 bogus 断言：host 形态断言未注册 label 子域 404 "Unknown preview
  host"（fail-closed）；dev 形态保持旧契约（未注册首段回落主站，响应不带预览
  拒绝文案）。

### nightly / staging 接线

`.github/workflows/ci.yml`（#416）：`schedule`（每日 19:31 UTC）+
`workflow_dispatch`（`only-craft-preview-e2e` 输入）触发唯一的
`craft-preview-e2e` job（same-site topology，`CRAFT_E2E_*` vars/secrets 命名
staging 栈；证据 artifact 归档 `.archive/runs/craft-preview/verification/`）。
其余 job 带 schedule/e2e-only 门，nightly 不重跑整份 CI。staging 环境接入前，
该 job 由脚本自身的 fail-loud 预检保持 RED（环境未配置时显式失败，绝不静默
绿灯）。

### 证据归档

运行产物（截图、`summary.json`、server 日志切片）落
`.archive/runs/craft-preview/verification/<UTC 时间戳>/`，`summary.json` 含
`topology` 字段标记本次 profile；票面 AC 回勾只认这里归档的产物。
