# ORCA-REPORT — craft-C2 批次：#409 / #411 / #412 / #413 / #414（Craft Preview 域）

- 分支：`1123786563/craft410`（HEAD `3ca32d49`，已含 PR #434/#435/#438/#441 全部 craft 修复线；origin/main 仅多 4 个纯 docs 提交，代码面等同）
- DB：容器 `orca-all-craft-pg`（5564，pgvector）保留未删；本批五票均为无 DB 单元/组件测试，未动库
- 测试两层制（docs/adr/0008）：原生层 `bunx e2e run --config e2e.unit.config.ts <file>`；Bun 层 `bun test ./server/tests/<file>`（本机 bun 1.4.2 直接跑含 node:module 依赖的文件会挂 `registerHooks`，走原生层；app 套件独跑红为进程偶合，取证用 `E2E_UNIT_SCOPE=app` 整组 967/967 绿）
- 总结论：**#409 SATISFIED（零改动）；#413 SATISFIED+FIX（+5 行测试断言）；#411 / #412 / #414 BLOCKED-GAP（缺口超 20 行或需 live 环境，留专项派发）**。本批无产品侧 IMPLEMENTED（0/1 名额）；代码改动仅 #413 的测试断言（未提交）

协调器裁定（本轮 ask 回复）：
1. #358 正文 D6 段不编辑，记录为「Spec 文件与 #364 已按 R-6 修订，#358 正文 D6 段为旧文，待票主同步」。
2. #409 AC6 采纳实现现状（hostname 隔离语义），报告中标注票面措辞差异，票面正文不改。

---

## #409 — CSP 增加 form-action、收紧 connect-src 并统一 AC1 语义（P0）→ **SATISFIED（零改动）**

**结论**：AC 六条全实证满足（AC6 按协调器裁定采纳 hostname 语义）。R 系列修复线（PR #438 F-1/F-2 收口、#441 验收收口、#440 origin 拒绝）已在 main 等价实现。票面改动范围中「收紧 connect-src 的 WebSocket 源」未做（AC 外实施项），记入遗留。

**AC 逐条实证**：

- AC1（preview fetch 主站 API 不拿会话，CSP 或 401 语义明确）✓
  - `scripts/craft-preview-acceptance.ts:1529` 步骤名即「拿不到平台会话（CSP 拒绝或 401）」，`:1556` CSP 就地拦截分支 + `:1633`「AC1 协议层：preview origin 发起的凭证请求不带主站 cookie（server 日志 401）」纵深步骤——语义统一已落地（PR #441）。
- AC2（form 提交到主站被 form-action 阻断）✓
  - `server/src/craft/webapp-proxy.ts:337-338` `WEBAPP_DEV_CSP` 含 `form-action 'self'`（另有 `frame-src 'self'` 收嵌套面）；`server/tests/craft-webapp-proxy.test.ts:84-91/710-713/868-870` 三处 VERBATIM 钉住 CSP 串；验收脚本 `:1562-1620` F-1 步骤 live 断言 `securitypolicyviolation(form-action)` 就地拦截。
- AC3（CSP 被绕过时主站 API 仍由 Origin 校验拒绝）✓
  - `server/src/craft/write-origin-guard.ts`（CP-04/#410，PR #440 已并）；`bun test ./server/tests/craft-preview-origin-guard.test.ts` **26 pass / 0 fail**：preview Origin credentialed POST → 403、四个非安全方法 403、任意深度子域 403、伪造/不透明 Origin 403。
- AC4（应用自身同源 fetch / 资源加载不回归）✓
  - `bunx e2e run --config e2e.unit.config.ts server/tests/craft-webapp-proxy.test.ts server/tests/craft-preview-origin.test.ts` → **196 passed (196)**，同源代理与 CSP 注入面全绿。
- AC5（HMR WebSocket 仍可连接）✓
  - `bun test ./server/tests/craft-webapp-hmr.test.ts` → **39 pass / 0 fail**；CSP 保留 `ws: wss:` 供 HMR 通道。
- AC6（前端不接受 scheme/port 不一致的 exchange origin）✓ 按裁定采纳 hostname 语义
  - `app/src/components/craft/output-panel/preview-tab.tsx:102-140`：`previewOriginBlocked`/`samePreviewHostname` 按 hostname 判定（fix-ocr4/6/8/26 线），注释含 RFC 6265 §5.1.3 实测论证（cookie 按 host 隔离、port 不参与——full-origin 比较反而漏同 host 异 port 的共享 cookie 罐）；`docs/craft-preview-origin.md:73-78` 记录该裁定与部署约束。
  - `E2E_UNIT_SCOPE=app` 整组跑 `app/tests/craft-preview-tab.test.tsx` **79/79 绿**（fix-ocr6 套件钉住 hostname 语义；单文件独跑 66 红为已知进程偶合，整组 967/967 绿）。
  - **⚠️ 措辞差异标注**：AC6 票面原文「从 hostname 改为完整 origin（scheme+host+port）」与 main 实现（hostname 隔离）方向相反；实现经 PR #434/#435/#438/#441 已审线交付且有论证+文档+测试三重钉住，按裁定采纳实现，建议人工审核时修订 #409 票面 AC6 措辞。

**命令与输出摘要**：
- `bunx e2e run --config e2e.unit.config.ts server/tests/craft-webapp-proxy.test.ts server/tests/craft-preview-origin.test.ts` → Tests 196 passed (196)
- `bun test ./server/tests/craft-webapp-origin-guard.test.ts`（实为 craft-preview-origin-guard）→ 26 pass / 0 fail
- `bun test ./server/tests/craft-webapp-hmr.test.ts` → 39 pass / 0 fail
- `E2E_UNIT_SCOPE=app bunx e2e run --config e2e.unit.config.ts`（整组）→ 128 files / 967 tests 全绿，其中 craft-preview-tab.test.tsx 79 tests ✓

**改动文件**：无。

**遗留**：
- 「按 dev/prod 收紧 connect-src 的 WebSocket 源」（#426 R07 并入 #409 的增量：dev `ws://127.0.0.1:<port>` 精确、host 形态 `wss://<label>.<preview-base>`）未做——现状 `connect-src 'self' ws: wss:` 通配，允许生成代码连任意主机的 WebSocket；docs/craft-preview-origin.md:212 现记为「语义正确」。收紧属产品侧 >20 行（CSP 函数化 + 两调用点 + 字面串测试同步），且验收纪律要求 live 断言 HMR 帧>0 且 console 无 CSP violation（需 #416 可复跑 e2e 环境），建议与 #416 合并专项派发。
- same-site 拓扑浏览器测试的「可复跑」形态归 #416（live 证据已存在于验收脚本 F-1 步骤）。

---

## #411 — server 读取 renewal-status 并在证书不可用时关闭（P0）→ **BLOCKED-GAP**

**结论**：核心（server 读状态文件 + admission 关闭）整链未实现，无等价物；仅「修正文档不实描述」半边已完成。

**AC 逐条实证**：

- AC1–AC5（缺失→null+reason+503 / starting 关闭 / critical+过期关闭 / ok+warn 原行为 / 更新后无需重启重判）✗ 全部未实现
  - `grep -rn "renewal-status|renewalStatus|TLS_STATUS|renewal_status" server/src/` → **零命中**；`OPENBOT_TLS_STATUS_FILE` 不存在。
  - `server/src/craft/preview-origin.ts` 的 `admission()`（:678）判定链只覆盖模板形态/端口/标签，无证书状态分支。
  - `docker/compose/services.yml` 无 `./tls:/etc/openbot/tls:ro` 挂载（挂载只在 `certs.yml:92` sidecar 自身）。
- AC6（dev 形态不依赖证书状态）✓ 天然满足（dev admission 不看证书），但这不是本票交付物。
- 「修正文档」半边 ✓：`docs/tls-certs.md:138-142` 已诚实重述「The server does **not** read it (grep over server/src at `bbea87ba`…)」——票面背景里「docs 声称 server 读取」的不实描述已被 fix-ocr 线修掉。

**已有底座**：certs sidecar 全套（`renewal-status.json` 五档 health、`renewal-guard.sh` 告警、`drill-renewal-failure.sh` 演练）就绪，本票只差 server 消费侧。

**缺口量级**：`config.ts` 新 env + `preview-origin.ts` admission 分支（读文件+mtime 缓存+五档判定）+ `services.yml` 挂载 + 两套测试（craft-preview-origin / craft-webapp-proxy 五档覆盖）——产品侧远超 20 行且跨 3 文件集，按分级留专项派发。

**改动文件**：无。

---

## #412 — 交付 preview 域名 TLS 消费与续期热加载（P0）→ **BLOCKED-GAP（与 #411 同根，TLS 消费链两半）**

**结论**：TLS 终结者（消费证书的那一端）未交付；R01(#420) 已收敛进本票的增量（edge 代理 + 探针）同样未实现。AC 六条中仅 sidecar 侧半边有底座。

**AC 逐条实证**：

- AC1（生产/staging `openssl s_client` 见证书）✗ `docker/compose/` 无 `edge.yml`（仅 certs.yml/kb.yml/lago.yml/observability/opik/services）；`charts/openbot/values.yaml` 无 preview ingress 样例；仓库内无任何 443 终结组件。
- AC2（换 cert 后无需重启、下次 TLS 连接用新证书）✗ 无终结者可热加载。`docker/compose/certs/reload.sh` 自述戳穿现状：`reload.stamp` 只是「the polling seam for a terminator」、`OPENBOT_TLS_RELOAD_URL` 可选；注释明确承认「**neither the healthcheck nor the alert loop reads lastReloadOk** … Alert consumption and #362's server-side read of the file are **the same pending batch** — renewal-guard.sh's TODO(consumer)」。
- AC3（续期失败演练触发 critical 告警、旧证书继续服务）◐ 半边：`drill-renewal-failure.sh` + renewal-guard 告警存在（sidecar 侧）；「旧证书继续服务」无终结者可证。
- AC4（证书缺失/过期时 admission 关闭）✗ 显式依赖 #411（未实现）。
- AC5（私钥 0600、凭据不入仓库）✓ `reload.sh` 每次重写后强制 `key.pem 600 / cert.pem 644`；`OPENBOT_TLS_HOST_DIR` 默认 `./tls` 在仓库根 gitignore 外（certs.yml:88-92），无凭据入库。
- AC6（文档启动/挂载/reload 步骤可复跑）◐ `docs/tls-certs.md` 对 sidecar 侧可复跑；TLS 消费侧（反代）无文档可复跑。

**与 #411 的同根关系**（批次说明要求说明）：两票同属「证书状态消费链」——#411 是 server 半边（读 renewal-status 关 admission），#412 是边缘半边（443 终结 + reload 联动 + 探针入 admission）；#420(R01) 的 `previewEdgeProbeUrl` 探针设计已并入 #412，其 AC4 显式依赖 #411，#412 并入评论第 6 条亦建议两票合并验收。与 #408(AC6) 的交叠：#408 管「生产空模板/缺 preview 域名 → 显式关闭」，与本两票同在 `admission()` 判定链但输入不同（模板配置 vs 证书状态），互补不冲突。

**缺口量级**：nginx-vs-traefik 决策记录 + `edge.yml`（443+只读挂 tls+Host 原样透传）+ `certs.yml` reloadcmd 改造 + `values.yaml` ingress 样例 + `config.ts`/`preview-origin.ts` 探针分支（缓存+超时+两态区分）+ 自签证书运行时证据（`openssl s_client`/换证热加载指纹/在途连接不断）——大交付，留专项派发。

**改动文件**：无。

---

## #413 — 落地 basePath R-6 决策并统一 #358/#364/实现（P1）→ **SATISFIED+FIX（+5 行测试断言）**

**结论**：R-6 决策已落地（env basePath + 白名单 + cwd/redirects 退场 + AGENTS 双形态口径），Spec 与 #364 已按 R-6 修订；本批补一行级断言把「裸 fetch 已知行为写入文档」钉进测试。唯一残留是 #358 父票正文 D6 段旧文（协调器裁定不编辑，待票主同步）。

**AC 逐条实证**：

- AC1（Spec 文件、#358、#364 三方表述一致）◐ 2/3
  - Spec `docs/specs/2026-10-15-craft-preview-origin-design.md:67` R-6 修订注（2026-10-16 批准，final-review F-2）✓
  - #364 正文已按 R-6 修订（2026-10-17 codex F-2 修订块 + AC 改写，5/6 已勾）✓
  - #358 正文 D6 段（:61）仍是旧文「lib/base-path.ts 退化为常量空串」，全文 0 次提及 R-6 ✗ ——**待票主同步**（协调器裁定本 run 不编辑）。
- AC2（生产 root 形态测试通过）✓
  - `bunx e2e run --config e2e.unit.config.ts server/tests/craft-webapp-template.test.ts` → **15/15 绿**（修后），含「no guesswork: the cwd sniff, the session-id regex and the redirects stay retired」「no env → BASE_PATH is the empty string and apiUrl is the identity (production unchanged)」「keeps the HMR relay's allowed dev origins」「whitelist parity lock: one pattern, three copies, zero drift（nextjs-dev.ts/next.config.ts/lib/base-path.ts）」。
- AC3（dev apiUrl() 路径 200，裸 fetch 已知行为被测试钉住并写入文档）✓
  - 文档：`server/assets/craft/web-template/AGENTS.md:8-9` 双形态口径 + 裸 fetch 404 已知行为原文。
  - 测试钉住：原有断言（`/<label>`/`apiUrl()`/`automatically`/不含 `resolveWebappBasePath`）+ 本批新增 `a raw `fetch()` / `404s beside` 两断言（本票 FIX）。
  - dev 路径 200 的 live 面：验收脚本 probe app 全部经 `apiUrl("/api/probe")` 发请求且 `:846` 断言 `http://127.0.0.1:<port>/<label>/api/probe` 就绪（#365 已验收线，PR #441 收口）。
- AC4（不再出现双基线）◐ 双基线残留仅 #358 正文一处（同 AC1）；Spec>票面优先级下无实现漂移。

**命令与输出摘要**：`bunx e2e run --config e2e.unit.config.ts server/tests/craft-webapp-template.test.ts` → 修改前 15 passed（缺裸 fetch 断言）→ 加断言首次红（字符串含 `**not**` 加粗）→ 对齐后 **1 file / 15 tests passed**。

**改动文件**（未提交）：
- `server/tests/craft-webapp-template.test.ts`：AGENTS.md 教学测试 两断言+三行注释共 5 行，把 #413 AC3「裸 fetch 已知行为被测试钉住」从仅文档变为文档+断言双钉。

**遗留**：#358 正文 D6 段待票主按 Spec R-6 修订注同步（一次 GitHub 正文编辑，本 run 无授权）。

---

## #414 — 验证并修复 preview origin 下的 Server Actions（P1）→ **BLOCKED-GAP**

**结论**：验收脚本的 Server Actions skip 已移除且协议级断言已实装（PR #441 线），AC1/AC5 满足；AC2（set-cookie action）/AC4（可展示错误面）无任何覆盖，probe app 需扩（+cookie action、+错误 action、+断言步骤），验收脚本侧 >20 行且需完整 craft live 环境复跑。

**AC 逐条实证**：

- AC1（preview iframe 内真实 Server Action → 200，数据返回）✓
  - `scripts/craft-preview-acceptance.ts:2064-2126`：probe app 内嵌真实 `"use server"` action（`PROBE_ACTION` :567-570 `ping()`），步骤断言 `probe-action` 点击 → `action-ok-` 出现，且**网络层证据**（next-action 头 POST 全部落在本会话预览 origin 且 200/303，foreign 列表必须为空）+ 截图 `09-server-action`。
- AC2（action 设置 cookie → preview 域 host-only cookie）✗ probe app 的 action 仅 `return "action-ok-…"`，无 set-cookie、无 redirect 形态。
- AC3（不携带/不泄漏平台 cookie）◐ 间接：AC1「cookie jar 真值」步骤（:1457）断言主站会话 cookie 只在主站 host、预览 host 只有通行证——但非 action 请求专属断言。
- AC4（失败时返回可展示错误，不是静默 404/500）✗ 无错误路径 action、无相关断言。
- AC5（#365 脚本不再 skip Server Actions）✓ `:2064-2065` 注释「Server Actions 不再 SKIP」+ 上述实装为 pass 类步骤；步骤映射表 `:193` `{ match: "Server Actions", acs: ["AC2"] }`。
- 模板 `next.config.ts` 的 `serverActions.allowedOrigins`/`allowedDevOrigins`：`allowedDevOrigins` ✓（含 HMR relay 的 127.0.0.1/localhost）；`serverActions.allowedOrigins` 未配——dev/host 形态下 action 均同源，Next 16 默认放行，暂非必需，但票面列为「必要时」注入项，随 AC2/AC4 扩展时一并裁定。

**命令与输出摘要**：本票证据面在验收脚本与模板静态面（上述行号）；live 复跑需完整 craft 环境（docker + dev server + 浏览器），本批未跑——AC1 的 live 证据属 #441 已收口验收线（#365 六票已 CLOSED），引用该线并标注。

**改动文件**：无。

**遗留**：probe app 增加 setCookie action + 错误 action + cookie/error 断言步骤 + `serverActions.allowedOrigins` 必要性裁定，留专项（建议与 #416 可复跑 e2e 同批）。

---

## 批次汇总

| 票 | 结论 | 改动 |
|---|---|---|
| #409 | SATISFIED（零改动；AC6 按裁定采纳 hostname 语义并标注票面措辞差异） | 无 |
| #411 | BLOCKED-GAP（server 消费侧整链缺失） | 无 |
| #412 | BLOCKED-GAP（TLS 终结交付缺失；与 #411 同根、建议合并验收） | 无 |
| #413 | SATISFIED+FIX（+5 行测试断言钉裸 fetch 教学） | server/tests/craft-webapp-template.test.ts |
| #414 | BLOCKED-GAP（AC2/AC4 验收面缺失） | 无 |

- 本批产品侧 IMPLEMENTED：0/1（名额未使用）。
- 未提交改动：`server/tests/craft-webapp-template.test.ts`（+6/-1 行）、本报告。
- 容器 `orca-all-craft-pg` 保留未删；未执行任何迁移。
