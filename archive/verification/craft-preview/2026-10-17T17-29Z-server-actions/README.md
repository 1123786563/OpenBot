# #414 实测证据：preview origin 下的 Server Actions

- Issue：https://github.com/1123786563/OpenBot/issues/414 （父票 #358，AC2）
- 采集时间：2026-10-17T17:29Z
- 仓库基线：`40ea53d3`；本轮读取的三个被测文件（`server/src/craft/webapp-proxy.ts`、
  `server/assets/craft/web-template/next.config.ts`、`scripts/craft-preview-acceptance.ts`）
  自 `bbea87ba` 起 `git diff --stat` 为空，故结论同时绑定 `bbea87ba` 与 `40ea53d3`。
- 被测运行时：Next **16.2.9**（模板 `package.json` 钉死）+ React 19.2.7 + TypeScript 6.0.3，
  真实 `next dev`，真实 Chromium（`playwright-core` + 系统 Chrome）。
- 本轮**未改任何产品代码**（用户裁决：先实测、只出证据）。

## harness 的范围与为什么选这条缝

`harness/proxy.ts` 直接 import 仓库真实的
`server/src/craft/webapp-proxy.ts` → `proxyWebappRequest`，因此走的是**产品自己的**
`stripRequestHeaders` / `EXCLUDED_REQUEST_HEADERS` / `EXCLUDED_REQUEST_HEADER_PREFIXES` /
`EXCLUDED_RESPONSE_HEADERS`（[server/src/craft/webapp-proxy.ts:246-305](../../../server/src/craft/webapp-proxy.ts#L246-L305)），
上游则是一台真实挂在 `/<label>` 上的 `next dev`（`ONYX_WEBAPP_BASE_PATH=/abc123`，
与模板同一个消费者侧白名单）。**没有**沙箱、没有 DB、没有 preview ticket、也没有 pass cookie 门。

选这条缝的原因：真实沙箱 e2e 仍被 #436（迁移漂移）与 #437（dev mount）阻塞，
且 #433 使真实网关上 `absent/empty` 不可区分；而本票要答的「代理剥离 `Origin` /
`x-forwarded-*` 之后 Next 怎么办」是一个纯协议层问题，在这条缝上可以完整测出。

`harness/proxy.ts` 里 `MODE` 提供三种上游头形态：`asis`（现状）、`keep_origin`（只放行 Origin）、
`keep_origin_xfh`（放行 Origin 并注入 `x-forwarded-host`/`x-forwarded-proto`）。
HMR WebSocket 做了桥接：不桥接时 Turbopack 客户端不定格、页面不 hydrate，
按钮点了没反应会被误读成「Server Actions 坏了」——那是 harness 的缺口，不是产品缺陷。

## 判定汇总（真实浏览器点击，非单测桩）

| 条件 | 上游实际看到的头（由 action 自己回显） | action | 浏览器可见结果 |
|---|---|---|---|
| 现状 `asis`：剥 `origin`+`cookie`+`x-forwarded-*`+`sec-fetch-*` | `origin=ABSENT`、`cookie_names=NONE`、`host=127.0.0.1:3399`、`x-forwarded-host=127.0.0.1:3399` | **200** | `action-ok-{…}` 正常返回 |
| 只放行 Origin（无 xfh、无 allowlist） | `origin=http://127.0.0.1:3299` | **500** | `Error:Invalid Server Actions request.` |
| 放行 Origin **并**注入 `x-forwarded-host`/`-proto` | `origin=http://127.0.0.1:3299`、`x-forwarded-host=127.0.0.1:3299` | **200** | 正常 |
| 放行 Origin + 模板配 `experimental.serverActions.allowedOrigins` | `origin=http://127.0.0.1:3299` | **200** | 正常 |
| 外部 Origin `http://evil.test`（上面两种配置下都试） | — | **500** | 可读错误，非静默 |

字节级重放（`harness/replay.ts`，用浏览器真实发出的那条 action 请求原样重放，
只换头部）给出同一结论：`1_ship_hygiene_shape` 200、`2_origin_matches` 200、
`3_origin_mismatch` 500、`4_mismatch_plus_xfh` 200、`5_foreign` 500、
`6_hygiene_plus_platform_cookie` 200（作为 AC3 的反证：只要不剥 `cookie`，应用就能看见平台会话）。

## 逐条 Acceptance

| AC | 判定 | 证据类型 |
|---|---|---|
| preview iframe 内真实 Server Action → 200、数据返回 | **达成**（在 dev 形态 `/<label>` 挂载 + 现状卫生下） | 真实浏览器 + 真实代理代码路径；`summary.json → rounds.drive_through_proxy_asis_ship_hygiene.results.ping` |
| action 设置 cookie → 浏览器收到 preview 域 host-only cookie | **未达成，且根因已定位到一行**：上游确实发出 `set-cookie: probe_host_only=stamp-1; Path=/; SameSite=lax`（Next 把它作为真实响应头发出，`Path=/`、无 `Domain` → host-only），代理丢 `set-cookie` → 浏览器 jar 只剩我预先植入的平台 cookie | 代理侧同一次 dial 的两个字段对照：`upstream_set_cookie=[…]` vs `proxy_set_cookie=[]`（`summary.json → rounds.proxy_side_captures_asis`） |
| 不携带 / 不泄漏平台 cookie | **达成**：浏览器把 `openbot_platform_session` 发到了预览端口（cookie 不认端口，dev 形态同 host 必然带上），代理剥净后上游 `cookie_names=NONE` | 浏览器 jar + 上游回显 + 代理捕获三处一致 |
| 失败时返回可展示错误，不是静默 404/500 | **达成**：抛错 action → 上游 500 → 代理原样 500 → 客户端拿到 `Error:probe-action-failed`；CSRF 拒绝 → 客户端拿到 `Error:Invalid Server Actions request.`。都不是静默 | 真实浏览器 `results.boom` 与 `drive-proxy-keep-origin-noallow.results.ping` |
| #365 脚本不再 skip Server Actions | **代码层已完成**（`8797d2d9`，票面写的「移除 skip」这一项不需要再动）；但脚本只断言「返回数据 + `next-action` 落到本会话 origin」，**没有** 设置 cookie / 重定向 / 故意失败这三条路径 | git 历史 + 静态代码 [scripts/craft-preview-acceptance.ts:426-431](../../../scripts/craft-preview-acceptance.ts#L426-L431)、[:1919-1980](../../../scripts/craft-preview-acceptance.ts#L1919-L1980) |

票面另外两条要做的实测也有结果：重定向 action → **303 + `x-action-redirect: /done;push`**
透传后浏览器落在 `http://127.0.0.1:3299/abc123/done`（代理不需要改写 `Location`）。

## 需要纠正的票面事实

票面写「在模板 `next.config.ts` 配置 `serverActions.allowedOrigins`」。**在 Next 16.2.9 上这个顶层键不被识别**：
dev 启动直接报 `Invalid next.config.ts options detected: Unrecognized key(s) in object: 'serverActions'`，
并且行为不变（CSRF 矩阵与不配时一致）。生效路径是
**`experimental.serverActions.allowedOrigins`**（源码依据：`dist/esm/build/templates/app-page.js:531`
取的是 `nextConfig.experimental.serverActions`；匹配器 `dist/esm/server/app-render/csrf-protection.js:65-74`，
按 **host:port** 精确或通配匹配）。改成 `experimental.` 前缀后同一 variant 由 500 变 200，实测见
`summary.json → rounds.replay_matrix_experimental_serverActions_allowlist`。

另：模板现有的 `allowedDevOrigins`（[server/assets/craft/web-template/next.config.ts:52-77](../../../server/assets/craft/web-template/next.config.ts#L52-L77)）
**不参与** Server Action 的判定——`action-handler` 只读 `serverActions.allowedOrigins`。它管的是 HMR/资产跨源。

## 本票真正要收的口子（安全结论）

源码 `action-handler.js:371-376`：缺 `Origin` 时 Next **放行**，只留一条 warning；
不匹配时才 500（`:377-418`）。而预览代理同时剥掉 `origin`、`sec-fetch-*`、`x-forwarded-*`
（`EXCLUDED_REQUEST_HEADERS` + `EXCLUDED_REQUEST_HEADER_PREFIXES`），
所以**今天这条链路上 Next 的应用级 CSRF 门恒为放行分支**——实测第 1 行就是这个的运行时表现。
也就是说：#410 刚在主站侧加的写接口 Origin 门（`40ea53d3`）和这里不是同一层，
应用侧那一层目前是空的。

## 边界：不能从这轮外推什么

- 没有沙箱、没有 ticket、没有 pass cookie 门 → **不证明** preview origin 的准入链，
  也不证明 host 形态（`<label>.preview.<base>`）。host 形态需要 HTTPS 模板与真实子域，本轮未测。
- **dev 形态下 `Origin` 本身没有区分力**：平台和预览同 host（`127.0.0.1:<port>`），
  Origin 不含路径，所以注入 `x-forwarded-host` / 配 allowlist 在 dev 形态只是「把 Next 的门重新武装起来」，
  不构成会话级隔离；只有在 host 形态（每个会话一个独立 host）它才携带真实信息。
  这一点与 #410 提交说明里「dev 形态按记录属不可判定」相互印证。
- 真实沙箱会话的端到端仍 blocked（#436 / #437），且 #437 的旧证据可能被旧代码进程污染（见 #417 核查）。

## 复现

```bash
H=~/.cache/craft414-harness   # 或直接在本目录的 probe-app/ + harness/ 里跑
cp -r docs/verification/craft-preview/2026-10-17T17-29Z-server-actions/probe-app $H
cd $H && bun install                       # next@16.2.9 命中本机 bun 缓存
ONYX_WEBAPP_BASE_PATH=/abc123 node node_modules/next/dist/bin/next dev -p 3399
MODE=asis PORT=3299 bun harness/proxy.ts &  # 真实代理卫生 + HMR 桥
MODE=proxy_asis PREVIEW=http://127.0.0.1:3299/abc123 bun harness/drive.ts
bun harness/replay.ts                       # 字节级头部矩阵（依赖上一步的 capture）
```

机器可读全量结果在同目录 `summary.json`（各轮浏览器证据、两版矩阵、代理侧逐请求捕获、
以及 Next 16.2.9 源码行号引用）。
