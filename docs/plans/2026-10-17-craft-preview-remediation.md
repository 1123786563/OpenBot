# Craft 预览独立 Origin — 现状修复方案（Issue #358 审核后）

- **基线**：`origin/main` = `44754feb`（PR #400 + #401 已合并）。审核证据取自 detached worktree `/private/tmp/openbot-audit-358`。
- **事实源**：Spec `docs/specs/2026-10-15-craft-preview-origin-design.md`（已批准，D1–D11 / AC1–AC9）、`docs/plans/tickets/craft-preview-origin/manifest.json`、GitHub #358–#367、`44754feb` 的代码与测试。
- **审核结论口径**：9 条 AC → verified 3（AC3/AC4/AC9）、partial 6（AC1/AC2/AC5/AC6/AC7/AC8）；D6 一项与 Spec 冲突。#359–#367 在 GitHub 上全部 OPEN、票面 AC 勾选数为 0，而 #358 正文把它们标为 `[x]`。
- **本方案性质**：实施计划（HOW）。不改变已批准需求；T4 是唯一需要回写 Spec 的任务，且已按用户决定定为「记录偏离」。

## 已采纳的决定（2026-10-17 用户确认）

- **R1** D6/basePath 冲突 → **修订 Spec 记录偏离**，不改实现去追求 dev 形态独立主机。
- **R2** 生产 preview 的 TLS → **外部反向代理承载 443**，server 保持纯 HTTP，`certs.yml` 产出的证书交给反代消费。
- **R3** 产出形式 → 本文件（`docs/plans/`）；不创建/修改任何 GitHub Issue、不改标签、不改 Issue 状态。

## 0. 执行前置（阻塞所有任务）

用户工作树 `/Users/wuyongjun/trea/OpenBot` 当前在 `main` = `ce1d9ce1`，**不含本波实现**：落后 `origin/main` 13 个提交、有 1 个未推送提交（`ce1d9ce1 feat(bifrost-5): integrate picker, discovery, sync, payer conflict`）、且暂存区含 bifrost-5 改动（`docs/plans/2026-10-16-bifrost-5-ledger.md`、`server/src/billing/*` 等）。

1. 先由你决定如何把本地 `main` 推进到含实现的基线（`git fetch` 后 rebase 或 merge 那个未推送提交）。**这一步需要人工确认**：本地有未推送提交与暂存改动，`reset --hard`/`checkout --` 会丢工，不在本方案授权范围内。
2. 推进后确认 `server/src/craft/preview-origin.ts`、`preview-ticket.ts` 存在，`git log -1 --oneline` 含 `44754feb`。
3. 并发 worktree 很多（`impl-36*`、`b5-2xx`、`fix-ocr3`）。每个修复任务按 `AGENTS.md` 使用**独立 worktree**，禁止共享 `git stash` 协调。

## 1. 任务总览与依赖

| ID | 优先级 | 目标 | 关联 | 依赖 |
|---|---|---|---|---|
| T1 | P0 | 生产 TLS/Host 路由闭环（外部反代消费证书） | AC6/AC8，#359/#361/#362 | — |
| T2 | P0 | 去掉「生产忘配模板仍准入开启」的危险默认 | AC6，#361 | — |
| T3 | P0 | 重建真实浏览器验收证据链并强制化 | AC1/AC2/AC5，#365/#366 | — |
| T4 | P1 | Spec 回写偏离 + 票面 AC 重述（R1） | D3/D6/AC2，#364 | T3（证据先于回勾） |
| T5 | P1 | 真实 Next dev server 的 HMR/DOM 热更新验证；替换源码字符串断言 | AC5，#363 | T3 |
| T6 | P1 | legacy 同源预览加边界与可见性 | AC1/AC7/D10，#367 | — |
| T7 | P1 | CSP 从「经论证的 no-op」变成按 origin 收敛 | 工单 03 步骤 5，AC1/AC2 | T3 |
| T8 | P2 | 通行证改为不透明 token + 索引（支持轮换） | AC4/D9，#360 | T2 |
| T9 | P2 | ACME sidecar 与 `parseTemplate` 锁步 + 输出脱敏 | AC8，#359 | — |
| T10 | P2 | 续期告警闭环成为硬要求 | AC8，#359 | T1 |
| T11 | P2 | `tls-pipeline.test.ts` 超时显式化，消除 CI 抖动 | #359 | — |
| T12 | P2 | label registry 落库／多副本（触发式） | AC3/AC9，M-2 | — |
| T13 | P2 | 跟踪一致性（正文 `[x]`、文档状态行、证据 gitignore） | #358–#367 | T3 |

**门禁（每个任务合入前必须全绿）**：
`bun test server/tests/craft-preview-ticket.test.ts server/tests/craft-preview-origin.test.ts server/tests/craft-preview-rejection.test.ts server/tests/craft-webapp-{proxy,hmr,template,generation,tool}.test.ts`（当前基线 140 + 217 全过）、`bun test app/tests/craft-preview-tab.test.tsx`（79 全过）、`cd server && bunx tsc --noEmit`（当前 exit 0）。

**审核期建的复跑件**：`/private/tmp/audit358-verify.ts`（真实 socket，15 断言，dev 形态；用 worktree + 主仓 `node_modules` 符号链接跑）。T3 的第一项工作就是把它吸收成仓库内正式用例。

---

## 2. P0

### T1｜生产 preview 形态的 TLS 与 Host 路由闭环（R2）

**问题事实**：`docker/compose/certs/` 会签出并续期 `*.<preview-host>`，但仓库内**没有任何消费者**——server 侧无 TLS 监听与证书读取（`grep -n "tls\|cert" server/src/index.ts` 无命中），`docker/compose/*.yml`、`charts/`、`deploy/` 中 grep 不到 443/nginx/traefik/caddy/preview；`renewal-guard.sh` 自述 consumer 为 `TODO(consumer #362)`。`certs.yml` 的 `reloadcmd` 重启的是一个不读证书的服务。结果：AC8 的「证书挂载与服务进程联动」与 AC6 的生产半边在仓库内无法成立。

**目标行为**：部署方按文档拉起栈后，`https://<label>.<preview-base>/...` 能被 TLS 终结并按 Host 转发到 server 的 HTTP 监听，且 server 能感知「生产 preview 入口是否真的可用」，不可用时准入关闭并给出可展示原因。

**写范围**
- 新建 `docker/compose/edge.yml`：反代服务（nginx:alpine 或 traefik，二选一在实现首步锁定并写明理由），`443` 端口映射，只读挂载 `docker/compose/tls/`（与 `certs.yml` 的 `--install-cert` 输出路径同源），`server_name ~^(?<sub>[0-9a-f]{20}\.)?<preview-base>$` + `proxy_set_header Host $host`（**必须原样透传 Host**：分流语义建立在 `request.url` 的 host 上，见 `server/src/index.ts:5781` 的 dispatcher）。
- `docker/compose/certs.yml`：`reloadcmd` 从 `docker compose restart openbot-server` 改为重载反代（`nginx -s reload` / traefik file-provider），保证「在途预览连接不被打断」。
- `charts/openbot/values.yaml`（`ingress.hosts` @651、`ingress.tls` @656）：补一个 preview 通配 host 的取值样例 + `reference/compose.md`、`reference/tls-certs.md` 的运行步骤（含 `OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE` 与反代 `preview-base` 必须同源这一点）。
- **server 侧新增可用性信号（准入输入）**：`server/src/craft/config.ts` 增加 `previewEdgeProbeUrl`（如 `https://probe.<preview-base>/`，或部署方声明的「入口已就绪」只读探针），在 `server/src/craft/preview-origin.ts` 的 `admission()`（:479）链上增加一条判定：模板为 host 形态且入口探针不可用 → `{ ok:false, reason: 可展示 }`。探针必须**带缓存与超时**，不得每请求拨号；不可用时给出的是原因文案而不是猜测。
- 测试：`server/tests/craft-preview-origin.test.ts` 增加「host 形态 + 入口不可用 → 503 + 原因，且 `originFor` 抛错」用例；`tests/compose.test.ts` 增加 edge 服务与证书卷断言。

**验证**
1. 本机用自签通配证书跑反代 + server（纯本地，不触真实 DNS/LE），`curl -k --resolve <label>.preview.localhost:443:127.0.0.1 https://<label>.preview.localhost/` 断言：TLS 成功、Host 原样到达、未知 label 得 404 `Unknown preview host.`、非 preview 主机仍走主站。
2. 关掉反代 → `webapp-info` 的 `previewOriginClosedReason` 给出入口不可用的句子（不是静默无地址）。
3. 门禁全绿。

**回滚点**：`edge.yml` 与 `config.previewEdgeProbeUrl` 均为附加项，置空即回到「不判定入口」的当前行为；不动 `preview-origin.ts` 的既有分支形状。

**DoD**：AC6 的「缺泛域名证书配置 → 显式关闭 + 原因」在仓库内既有判定分支、又有可跑通部署路径；AC8 的「挂载与服务进程联动」有真实 reload 生效证据（证书轮换后 TLS 握手拿到新指纹）。

---

### T2｜去掉危险默认：生产不得静默落进 dev 形态

**问题事实**：`server/src/craft/config.ts:481-490` 是 `previewOriginEnabled` 默认 `true`、`previewOriginTemplate` 默认 `""`；`admission()`（`server/src/craft/preview-origin.ts:479-505`）不含任何「这个部署是否可被公网reach」的判定。于是**忘配模板的生产部署准入是开的**，`originFor` 铸出 `http://127.0.0.1:<port>/<label>`（:533）——对远端访问者是不可达地址，而不是 AC6 要求的「功能明确关闭并说明原因」。

**关键约束（不要重犯）**：**不得用 `NODE_ENV` 作为生产信号**。`server/src/config.ts:584-586` 明确记录 `Dockerfile` 给每个容器、`openbot.commonEnv` 给每次 chart 安装都设 `NODE_ENV=production`，包括 chart 自己宣传的本地试用；`isProduction()`（:537）也不是这个问题。正确的信号是仓库已有的 **`reachOf()`**（:654，判定 `localhost` / `::1` / `127.x`、折叠尾点与方括号），`singleUserAllowed` 就是用它回答「别人能不能碰到它」。

**目标行为**：dev 形态（空模板 → `127.0.0.1`）只在「本部署只有 loopback 地址可被使用」时开放；一旦存在公网可达地址（`OPENBOT_PUBLIC_URL` / `OPENBOT_APP_URL` / 非 loopback 的 `TRUSTED_ORIGINS`），空模板 → **准入关闭 + 可展示原因**，指向 `OPENBOT_CRAFT_PREVIEW_ORIGIN_TEMPLATE`。

**写范围**
- `server/src/config.ts`：把 `reachOf` 的使用收敛为一个导出谓词（例如 `publiclyReachable(environment): boolean`），复用其归一化规则，避免第三处自造信号；在文档注释里写明「与 `singleUserAllowed` 同一个问题」。
- `server/src/craft/preview-origin.ts`：`admission()` 增加一条判定（位置在 template 形状判定之后、端口判定之前），dev 形态且 `publiclyReachable` → `{ ok:false, reason: "..." }`。
- `server/src/craft/config.ts`：`previewOriginEnabled` 保持默认 `true`（不改默认值就能修好危险路径，避免兼容面扩大），但把注释改成新语义。
- 测试：`craft-preview-origin.test.ts` 三条新用例——公网可达 + 空模板 → 503 + 原因；loopback-only + 空模板 → dev 形态照常可用（回归保护，`127.0.0.1` 默认形态不能被破坏）；公网可达 + host 模板 → 不受此判定影响。

**验证**：`bun test server/tests/craft-preview-origin.test.ts`；再起一个真 server（`OPENBOT_PUBLIC_URL=https://openbot.example.com`、模板留空）跑 `GET /api/craft/sessions/<id>/webapp-info`，断言 `webapp_url:null` 且 `previewOriginClosedReason` 指向模板变量。

**回滚点**：该判定是 `admission()` 里的一条独立分支，删掉即回到当前行为；`reachOf` 谓词为纯新增导出。

**DoD**：不存在「生产忘配 → 铸出不可达地址」这条路径；AC6 的缺配置分支在 dev 形态侧也被覆盖。

---

### T3｜重建真实浏览器验收证据链，并让它可强制

**问题事实**：全局约束写「每张 Ticket 完成须以真实浏览器证据为准（Playwright + Casdoor 登录 + 真实 dev server），单测桩不算通过」。实际状态：
- `scripts/craft-preview-acceptance.ts`（1787 行）确实真跑浏览器与 CDP，但**未接入任何 CI 或 npm 脚本**（全仓 grep 仅命中自身；`.github/workflows/*.yml` 对 craft/preview/acceptance 零命中；文件名非 `*.test.ts`，`bun test` 也不收集）。
- 唯一落盘产物 `.../impl-365/gui-test-screenshots/craft-preview-365/RUN-2026-10-15.log` = **17 PASS / 3 FAIL / 2 SKIP / 2 FINDING**，3 个 FAIL 正是 F-1 面板换票进入、UI 点击→POST、AC5 DOM 热更新；`commit 51509433` 声称的 run6「21 PASS / 0 FAIL」对应截图与日志在磁盘和 git 中都不存在。
- `gui-test-screenshots` 被 `.gitignore` 忽略 → 证据天然不可归档、不可复核。

**目标行为**：一条可强制、可复核、可归档的验收路径；票面 AC 只有在存在归档产物时才回勾。

**写范围**
1. **吸收审核 harness**：把 `/private/tmp/audit358-verify.ts` 的 15 项断言移植为 `server/tests/craft-preview-socket.test.ts`（真实 `Bun.serve`，非 `app.request`）：换票 302 + cookie 属性字面串、重放 401、注入时钟过期、他人通行证、会话删除后不可兑换、四动词透传、label 挂载保留、`cookie`/`authorization`/`origin` 不出现在上游、CSP 落在代理响应、`/api/**` 在 dev 形态落回主站路由、重启后旧 label 不再被认领。
2. **接线**：根 `package.json` 增加 `test:live-craft-preview`（模式对齐既有 `test:live-*`：缺 `.env`/前置服务时**先报错退出 1**，不允许静默 skip 后返回 0）；`scripts/craft-preview-acceptance.ts` 的 preflight 失败必须是非零退出并打印缺哪一项。
3. **产物归档**：输出目录改为 `.archive/runs/craft-preview/verification/<UTC 时间戳>/`，内容含 `summary.json`（逐条 `AC → PASS/FAIL/SKIP + 断言细节`）、每张截图、server 日志切片；脚本改为写 `summary.json` 而不是只 print stdout。
4. **补齐 AC1 的字面 401**：现证据里页面内跨源 fetch 是被 CSP 拦成 `TypeError: Failed to fetch`，字面 401 只在 server 日志步。脚本需分别断言两层——(a) 浏览器侧被拦（说明 CSP 生效），(b) 绕过 CSP 的直连（`fetch` 目标改用允许的路径或在页面外用 CDP 发请求）得到 401 且响应体可读，并在 `summary.json` 里标成两条独立证据，避免再用「CSP 拦截」冒充「origin 隔离 401」。
5. **CI**：新增 workflow 只跑第 1 项的单测/类型检查（无外部依赖）；live 验收保持人工触发但产物必须作为 PR 附件或提交进上表的归档路径。不要给 CI 配真实 DNS 凭据。

**验证**：`bun test server/tests/craft-preview-socket.test.ts` 必须无前置依赖全绿；`bun run test:live-craft-preview` 在沙箱/Casdoor 起来时产出 `summary.json`，AC1/AC2/AC5 三行必须是 PASS 才能进入 T4 的回勾。

**回滚点**：全部为新增文件/脚本，不改生产代码路径。

**DoD**：#365/#366 的「真实浏览器证据」由「声称」变成仓库内可复核产物；run6 类无产物的声明不再作为完成依据。

---

## 3. P1

### T4｜按 R1 回写 Spec，并重述 #364 票面（不假装满足）

**问题事实**：Spec D6（`docs/specs/2026-10-15-craft-preview-origin-design.md:65`）要求 `basePath`/`assetPrefix`/`redirects` **全部删除**、`lib/base-path.ts` **退化为常量空串**。实现（`server/assets/craft/web-template/next.config.ts`、`lib/base-path.ts`）在 dev 形态仍按注入 env 设 `basePath`+`assetPrefix`，`BASE_PATH` 读 `NEXT_PUBLIC_BASE_PATH`；`reference/craft-preview-origin.md:177` 已承认「F-2（#365 R-6）**恢复** env 驱动」。`#364` 票面 5 条 AC 在 GitHub 上 0 勾选。按 `AGENTS.md`「实现与批准 Spec 冲突应升级处理」，已升级为决定 R1。

**写范围**
- Spec 增补（**只加不改语义**，逐条带理由）：
  - D3/D6 改为：「basePath 机制在**生产 host 形态**整体退场（应用跑 origin 根路径）；**dev 形态**因不依赖本地泛域名 TLS，保留 `/<label>` 受控 env 注入挂载，`apiUrl()` 是该形态下生成代码访问自身 API 的唯一受支持路径。」
  - AC2 补一条 dev 形态限定：「生成代码的裸 `fetch("/api/...")` 在 dev 形态仍会进入宿主 `/api/**` 命名空间，但**不携带平台会话**（cookie host-only + 跨站 `SameSite=Lax`）→ 401/404；该形态的隔离依据是 host 不同，不是路径不可达。」
  - 新增「已知偏离」小节：记录 cwd 正则、`redirects` 兜底、无条件 `assetPrefix` 已删除（D6 已满足的部分），与保留 env 注入挂载（偏离部分）及收敛条件（若将来 `*.localhost` 本地 TLS 成本可接受，再切独立主机）。
- `docs/plans/tickets/craft-preview-origin/issues/05-scaffold-drop-basepath.md` 的 AC 重写为新契约（不再含「next.config.ts 不再含 basePath/assetPrefix」这类与契约矛盾的字面项）。
- `reference/craft-preview-origin.md` 首部状态行（现写「#360–#363 交付轨迹」）更新为实际落地范围，并把 dev 形态的足枪写入「已知约束」。

**验证**：Spec/票面/实现三者一致（人工比对清单）；`grep -n "basePath" docs/specs/2026-10-15-craft-preview-origin-design.md` 的措辞不再与实现互斥；`server/tests/craft-webapp-template.test.ts` 的断言与票面新 AC 对应（该文件当前已钉 `BASE_PATH` 白名单与三方正则 parity，217 测试全过）。

**顺序约束**：T4 的回勾动作依赖 T3 的产物；**不得**在没有归档证据时把任何票面 AC 改成 `[x]`。本任务只动 Spec/票面文字，不动 GitHub（GitHub 侧回勾由你或 coordinator 决定）。

---

### T5｜真实 Next dev server 的 HMR 与 DOM 热更新

**问题事实**：`server/tests/craft-webapp-hmr.test.ts`（960 行）验证的是服务端 upgrade 解析 + 自建 `Bun.serve` 假 dispatcher + **echo 假上游**；另有 3 个 `source pin` 测试用 `readFileSync` + 正则匹配源码字符串。真实 Next dev server 下的「帧数 > 0 且改一行 → DOM 变化」在唯一浏览器轮是 FAIL，此后无产物。

**写范围**：T3 的 live 脚本增加两段——(a) 沙箱内起**真** Next dev server，断言 `/_next/webpack-hmr` 升级成功、帧计数 > 0、编辑一个组件文件后 DOM marker 变化（AC5）；(b) 把 3 个源码字符串断言替换为行为断言（例如「preview 分支的升级判定不依赖 `webappProxyEnabled`」应由真实装配对象证明，而不是读 `index.ts` 文本）。若个别源码断言确属必要（防止装配漂移），保留但在注释里写明它**不**计入验收证据。

**验证**：live 脚本 `summary.json` 的 AC5 行为 PASS + 截图；门禁全绿。

---

### T6｜legacy 同源预览加边界

**问题事实**：D10 让存量会话继续走同源旧路径（`server/src/craft/webapp-proxy.ts:404-405` `legacyWebappPreviewPath`，:870 返回相对 `webapp_url`）。在该形态下 `connect-src 'self'` 的 `'self'` **就是主站 origin**，且面板带平台 cookie iframe → 本波要修的「生成代码以登录用户身份读写平台 API」对存量会话**仍然成立**，无到期时间、无总开关。AC1 对 legacy 会话不成立（设计接受，但风险未收口）。

**写范围**
- `server/src/craft/config.ts` 新增 `legacyPreviewEnabled`（建议默认 `true` 保持兼容，但提供一键关闭；命名与既有 `boolEnv` 模式一致）。关闭时 legacy 会话在 `webapp-info` 得到 `webapp_url:null` + 可展示原因（复用 `previewOriginClosedReason` 面），前端显示「该会话的预览与平台同源，已被部署方禁用，请重建 web app」。
- `app/src/components/craft/output-panel/preview-tab.tsx` 的 legacy 提示（现 `legacyNotice`）补上「与平台同源」这一风险表述；i18n 两份 locale 同步。
- `reference/craft-preview-origin.md` 存量会话一节记录：风险、开关、收敛办法（重建 app 会写 `.webapp-generation` 标记即翻转为 current，见 `server/src/craft/webapp-generation.ts:67`）。

**验证**：`craft-webapp-proxy.test.ts` 增「legacy 开关关闭 → null + 原因，不换票（409 路径不变）」；前端测试 `craft-preview-tab.test.tsx` 增提示断言；可选 live：legacy 会话在开关关闭时面板给出可读原因而不是 iframe。

**DoD**：AC7 的「可用或明确给不可用原因」把「不可用」也变成部署方可选，且 AC1 的例外被显式声明与可关闭。

---

### T7｜CSP 从注释论证变为按 origin 收敛

**问题事实**：工单 03 实施步骤 5 要求「重算并**收紧** CSP」。`WEBAPP_DEV_CSP` 字符串（`server/src/craft/webapp-proxy.ts:320-321`）与波前 `563fe88d` **逐字节相同**（`git log -S` 仅 `d1278058` 引入），本波只在 :312-319 加了注释论证 `'self'` 语义。现状 `connect-src 'self' ws: wss:` 允许生成代码连**任意主机**的 WebSocket；`script-src` 仍是 `'unsafe-inline' 'unsafe-eval'`（Next dev 必需，非本任务目标）。

**写范围**：把 CSP 从常量改为按会话地址生成的函数（`previewResponseCsp(appOrigin)`），在 `proxyWebappRequest` 响应头处（:377-381）由调用方传入：
- dev 形态：`connect-src 'self' ws://127.0.0.1:<port>`（精确 host:port）。
- host 形态：`connect-src 'self' wss://<label>.<preview-base>`。
- 其余指令保持不变；`'unsafe-eval'` 明确写为 dev 预览的已批准例外并注明理由，避免被误读为疏漏。

**注意**：`'self'` 在 preview origin 下已覆盖应用自身 fetch 与 Server Actions；`ws:` 只在 scheme 不同时必要（HMR 是 `ws://` 而文档是 `http://`）。改后必须实测 HMR 不被 CSP 拦（T3 的 live 脚本跑这条）。

**验证**：单测断言两种形态的 CSP 串；live 断言 HMR 帧数 > 0 且 `console` 无 CSP violation；`craft-webapp-proxy.test.ts` 更新（现断言里含 CSP 字面串）。

---

## 4. P2

| ID | 目标与落点 | 验证 |
|---|---|---|
| T8 | **不透明通行证**：`preview-origin.ts:765` 现把明文 `sessionId` 写进 `openbot_preview_session`。改为随机 token + 内存/持久索引（映射到 sessionId），沿用 `previewSessionCookieHeader` 的 value/path 白名单（`preview-ticket.ts:176/187`）。当前已有缓解（代理剥 `cookie`，`webapp-proxy.ts:256`），本任务解决的是**轮换能力** | `craft-preview-ticket.test.ts` + 新 socket 用例：旧 token 在轮换后失效 |
| T9 | **sidecar 与 server 模板判定锁步**：实测 `sh lib.sh __derive` 对 `https://{session}.127.0.0.1:3001`、`{session}.com`、`{session}.a..b` 返回 ok，而 `preview-origin.ts:341/417/422` 分别拒绝；`lib.sh:182-189` 注释已过期。另 `entrypoint.sh`/`lib.sh` 把 acme.sh 输出尾部逐字写入 docker logs 与 `renewal-status.json`，DNS 插件若回显 token 即入库 | 新增锁步用例表（同一批模板串喂两侧，断言判定一致）；输出脱敏后 `grep -i token` 在日志与状态文件中 0 命中 |
| T10 | **告警闭环成为硬要求**：`OPENBOT_TLS_ALERT_WEBHOOK` 默认为空、仓库无 Loki/Grafana 规则、`renewal-status.json`/`reload.stamp` 零读取。改为：host 形态部署时未配置告警通道 → sidecar 拒绝启动并给原因；并交付一组可导入的告警规则 | `tls-pipeline.test.ts` 增「无 webhook 且声明生产 → 拒绝启动」 |
| T11 | **测试抖动**：默认超时下 `scripts/tls-pipeline.test.ts` = 95 pass / **4 fail（5s 超时）**+ 3 errors；`--timeout 60000` = 99 pass / 0 fail（137s）。根因是慢子进程与 bun 默认 5s 竞争，非代码缺陷。给这些用例显式 `timeout`，并考虑把 spawn 密集用例移出根 `bun run test`（它含 `./scripts`） | `bun test scripts/tls-pipeline.test.ts`（不带 `--timeout`）连跑两轮全绿 |
| T12 | **registry 落库／多副本**（触发式，不主动做）：`preview-origin.ts:477` 是内存 `Map`，`reference/craft-preview-origin.md:84` 已记 M-2（重启后旧地址 404／落回主站，须经主站重进重铸；已注册才认领）。触发条件：出现多副本部署，或运维反馈「重启丢预览」成规模 | 触发后再立票 |
| T13 | **跟踪一致性**：#358 正文把 #359–#367 标为 `[x]` 而 9 票全 OPEN、票面勾选 0；`reference/craft-preview-origin.md` 状态行滞后；`gui-test-screenshots` 的 gitignore 使证据不可归档（与 T3 配套）。GitHub 写入需你授权，本方案只准备文案 | 人工核对清单 |

---

## 5. 建议完成度口径（不要在 T3 前宣布验收）

- **可以现在宣布已验证**：AC4（含并发/重放/TTL/会话删除，单测 + 我的真实 socket 复现）、AC9（HMAC 20 hex，80 bit，非 id、不可枚举）、AC3 的服务端强制部分、D11 的 current 代际 `webapp_url` 绝对化 + preview-tab 消费、`webapp tool` 与预览指向同一 `session.nextjsPort` 的端口同一性。
- **必须等 T3 产物才能宣布**：AC1 的浏览器层（含「401 而非 CSP 拦截」这一语义修正）、AC2 的 Server Actions、AC5 的 HMR DOM 热更新与全屏放大回归、AC7 的旧会话运行时行为。
- **必须等 T1/T2 才能宣布**：AC6、AC8 的生产半边。在此之前，AC8 只能表述为「ACME 流水线代码 + 离线测试已实现，生产运行未证实」。
- **T4 前不要动**：#364 票面与 Spec 的 D6 措辞；一旦 R1 落地，票面 AC 需与新契约一致，避免「代码对了、票面写错了」的长期不一致。

## 6. 风险

- **T1 反代选型未定**：nginx 与 traefik 对通配 SNI、Host 透传、reload 语义不同；实现首步必须先定并写理由，否则 `edge.yml` 与 `certs.yml` 的 reloadcmd 会来回改。
- **T1 的入口探针可能引入新的抖动面**：必须带缓存与超时，且**不可用**要区别于「尚未探测」；否则一个探针故障会把可用部署判成关闭。
- **T2 的公网判定依赖 `reachOf` 现有语义**：若部署用 IP 直连或非 `127.x` loopback 形式，需先扩谓词再改准入，别在 `preview-origin.ts` 里重写一份主机判断（那正是 `fix-ocr19 #11`/`fix-ocr23 #8` 一路在收敛的重复实现问题）。
- **T7 改 CSP 会打死 HMR**：必须与 T3 的 live 脚本同时验证，不能只靠单测。
- **T6 的 legacy 关闭是行为变更**：默认值选择决定影响面，建议默认 `true` 并在文档给到期收敛路径，而不是直接默认关。
