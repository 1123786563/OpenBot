# [craft-C3] 批次核验报告 — #415 #416 #405 #425 #427

工作区：`craft410`（HEAD `3ca32d49`，origin/main 仅领先 6 个 docs/test/ci 提交，R 系列 / #434 / #441 线全部经 merge-base 祖先实证已在 HEAD）。
DB：`postgres://postgres:postgres@127.0.0.1:5564/craft`（容器 orca-all-craft-pg，保留未删）。
跑法：原生层 `bunx e2e run --config e2e.unit.config.ts`，Bun 层 `bun test ./<file>`（ADR 0008 两层制；craft-preview 系套件导入 helpers/refusals.ts 用 Node registerHooks，属原生层；tls-pipeline/craft-preview-socket 在 docs/verification/e2e-bun-suites.json 清单，属 Bun 驱动层）。

---

## #415 server 与 ACME sidecar 模板校验统一 — **IMPLEMENTED**（本批唯一产品侧 IMPLEMENTED）

**核验**：两侧校验主体早已存在——`server/src/craft/preview-origin.ts:474` `parseTemplate`（拒绝 IDN/userinfo/trailing dot/underscore/IPv4/非 https/port 0/空 label/单标签基座）与 `docker/compose/certs/lib.sh:183` `derive_preview_host`，交叉引用 golden pin（scripts/tls-pipeline.test.ts ↔ craft-preview-origin.test.ts）。但两处票面点名的交叉缺陷仍在（实证）：

1. **`*`**：WHATWG 可解析 `*` 为 hostname（探针 `new URL("https://probe.*.example.com")` PARSE OK），server 侧无检查 → 探针实测 admission 对 `https://{session}.*.example.com` 返回 `{ok:true}`，铸非法 host；sidecar base 正则拒 `*` → 正是票面背景「server 接受、sidecar 拒绝」的 crash-loop 分歧类（fix-ocr18 #9 方向）。AC2 未满足。
2. **`a..b`**：fix-ocr27 #2 只收紧了 server（拒空 label），sidecar lib.sh 仍接受并 pin `ok|https|a..b`（我跑 tls-pipeline 115/0 时该 pin 活着）→ 两侧结论不一致。AC1/AC3 未满足（记录为 recorded deviation，但 #415 正是要收这个口）。

**修复（TDD RED→GREEN，全部实证）**：
- RED₁：craft-preview-origin.test.ts 新增 `#415: a wildcard * label in the base is refused`（两案例）→ 112 tests / 1 failed。
- GREEN₁：`parseTemplate` underscore 检查后加 `probe.hostname.includes("*")` 拒绝 → 112/112。
- RED₂：tls-pipeline.test.ts `a..b` pin `ok→invalid` + 新增 `*` 两案例（sidecar 本就拒 `*`，直接绿）→ 117 tests / 1 failed（a..b）。
- GREEN₂：lib.sh base 校验后加 `case "$base" in *..*) invalid` 并重写 fix-ocr19 #9 注释（recorded deviation 闭合）→ 117/117。
- 同步更新 craft-preview-origin.test.ts:826-838 过时的「sidecar still accepts」注释。

**AC 逐条**：
- [x] AC1 同一模板两侧一致结论：修复后 `a..b`/`*` 双侧同拒；其余案例（`a-.b` ok、trailing `:` ok、`{Session}`/IDN/userinfo/underscore/端口等 invalid）本就双侧交叉 pin。
- [x] AC2 `*` 不再产生不可解析 preview host：admission false + `originFor` throw + `handlesRequest` false，测试实证。
- [x] AC3 `..` 不再让 sidecar 尝试签证书：lib.sh 拒绝 + tls-pipeline pin `invalid`。
- [x] AC4 CI 同时跑两侧 golden cases：tls-pipeline 在 e2e-bun-suites.json 由 `tests/bun-suites.test.ts` 驱动、craft-preview-origin 原生收集，CI 测试 job 跑 `bun run test:ci`（ci.yml:459）。

**形态差异（说明，非缺口）**：票面「共享 golden fixture（JSON）」实现为交叉引用 pin——两侧各自 pin 同一组案例、注释互指对方文件；目标等价（任一侧裁决漂移即在本侧测试红），未新建 JSON 文件。

**改动文件**（未提交区）：`server/src/craft/preview-origin.ts`(+11)、`server/tests/craft-preview-origin.test.ts`(+41/-13)、`docker/compose/certs/lib.sh`(+14/-11)、`scripts/tls-pipeline.test.ts`(+14/-7)。产品侧核心逻辑 server 4 行 + lib.sh 6 行（其余为注释/测试）。

**回归**：原生层 7 套件（origin 112 / rejection 24 / ticket 24 / pass 17 / webapp-proxy 85 / template 15 / config 4）= 281/281；Bun 层 socket 14 + hmr 39 = 53/0；tls-pipeline 117/0；server `tsc --noEmit` exit 0；biome 对改动文件零新增发现（7 条预存发现与 HEAD 基线同构，行号平移一致）。

---

## #416 可复跑全栈 e2e：same-site + HMR + Server Actions — **BLOCKED-GAP**

**核验**：等价物已存在且硬化的部分——`bun run test:live-craft-preview`（根 package.json:34）驱动 `scripts/craft-preview-acceptance.ts`（6b731c93 T3 harden）：Server Actions 真实执行（:2070-2084 网络层记录 next-action POST 断言 probe-action → action-ok）、AC5 HMR 两 socket（hmrWsUrl :161）+ 文件改动 + 热更新生效、AC1/AC3、#358 伪造凭据双面拒绝、全屏放大；PASS/FAIL/SKIP 如实输出 + 截图留证 + preflight 前置自检。

**缺口（不实施的原因）**：
1. **same-site 拓扑 profile 不存在**：脚本只有 preview 独立 origin（cross-site）场景；AC「same-site 场景证明主站 cookie 不会被 preview 静默读写」无任何覆盖。需新增 same-site 环境拓扑 + 脚本场景分支。
2. **nightly/staging 接入**：`.github/workflows/` 仅 security_zizmor.yml 有 schedule；验收脚本无 CI 调度，仍只在 PR 描述/手工。
3. 入口名 `test:craft-preview-e2e` 不存在（等价物为 `test:live-craft-preview`，纯命名差异）。

量级为测试基建（新拓扑环境 + workflow 新文件 + 脚本分支），远超 20 行测试侧小修 → 留专项派发。

---

## #405 preview 代理转发应用 cookie 并安全处理 Set-Cookie — **BLOCKED-GAP**

**核验**：现状为全剥离语义且被测试钉死——`server/src/craft/webapp-proxy.ts:258` `EXCLUDED_REQUEST_HEADERS` 含 `cookie`，`:287` `EXCLUDED_RESPONSE_HEADERS` 含 `set-cookie`（注释明示 "an app must not set cookies on the parent domain"）；`server/tests/craft-webapp-proxy.test.ts:95/:101` 断言两向均 null。header hygiene 现有测试不回归（AC5 满足），但 AC1-AC4 全部未满足。

**缺口**：#405 的放宽语义（只剥平台 pass cookie、转发应用 cookie；允许上游 Set-Cookie 但去 Domain/限 Path/保留多 header）需要选择性剥离逻辑 + Set-Cookie 属性清洗 + cookie round-trip/Domain 拒绝/多 header 测试族——产品侧 >20 行，且是安全边界变更（#427 票面确认 R 系列审计依赖该剥离边界防生成应用读平台凭据；放宽时须保 #431/#427 的 fail-safe 与剥离边界不退化）→ 留专项派发（建议实现票明确「平台 pass 与应用 cookie 分离 + Set-Cookie 清洗」契约）。

---

## #425 R06 legacy 同源预览开关 — **BLOCKED-GAP**

**核验**：`legacyPreviewEnabled` 不存在于 `server/src/craft/config.ts`（boolEnv 清单逐项核对）；webapp-info legacy 分支（craft-webapp-proxy.test.ts:1415-1593）无关闭开关/关闭原因面；`legacyNotice` 文案（app/src/locales/{zh-CN,en}/craft.json:33）只说「旧路径」，无「同源、生成代码可用你的会话访问平台 API」风险表述；docs/craft-preview-origin.md 无存量会话开关/收敛办法记录。AC5（unknown 落 current 形状 + legacy mount 交叉校验）已有且全绿（fix-ocr27 #3 测试）。

**缺口**：部署级一键关闭 + webapp_url:null+原因面（不换票）+ 前端风险文案 + 文档，写范围跨 6 文件、产品侧 >20 行；本批唯一 IMPLEMENTED 槽已用于 #415（真实缺陷修复优先于功能增量）→ 留专项派发。票面 Implementation steps 已足够具体（含默认值建议 true 与 AC7「部署方可选」纪律）。

---

## #427 R08 preview 通行证不透明 token + 索引 — **SATISFIED（零改动；#431 等价且更强）**

**核验**：#431 T1/T2 已并 main 且在本工作区 HEAD（b12a0840 签名 pass 原语 + 70924c42 HTTP/HMR 共用 verify + owner 复核，merge-base --is-ancestor 实证）。票面引用的 `previewSessionCookieHeader(sessionId, …)` 明文种值已被 `server/src/craft/preview-pass.ts` 替换。

**AC 逐条**：
- [x] 兑换种下随机不透明 token：`v1.<b64url(userId)>.<b64url(HMAC-SHA256)>`，常量时间比较；cookie 值不再是 sessionId（craft-preview-pass.test.ts:73 "the old plaintext session id is NOT a pass"）。
- [x] fail-safe：自造值/错版本/1 字节 MAC 翻转/跨会话/跨密钥/超长/非字符串全部 verify→null→401（pass 17 测试全绿）；「查不到就放行」在无状态 MAC 方案下构造性不存在。
- [x] 白名单两条边界继续覆盖新值：`PREVIEW_PASS_COOKIE_SHAPE` 由 preview-pass.ts 导出供 preview-ticket.ts 消费（单源不可漂移）；path 白名单（ticket 测试 :428/:455）、value 白名单（:483/:160/:173）。
- [x] R-9 dev 形态 Path=`/<label>` 并存不覆盖：:428 测试。
- [x] 阴影不遮蔽：craft-preview-origin.test.ts:1943-1987 浅影+深影均遍历全部同名候选。
- [x] 通行证值不进日志/不回显：模块级「Every refusal is null」+ rejection :285「every refusal is ticket-free」。
- [x] 轮换语义：模块头 Rotation semantics + docs/craft-preview-origin.md:185-191（轮换 key/版本 → 全部 pass 失效，主站重新换票即恢复，不影响会话本身）。
- 形态差异（说明）：「随机 token + 服务端索引」被「HMAC 签名绑定 (sessionId,userId)」替代——无状态、重启不失效（优于内存 TTL 表；M-2 重启行为已由 restart-gap 测试与文档记录），轮换能力等价（换密钥即作废）。

**关闭纪律重跑**：跨会话拒绝（AC3）与并发兑换恰一成功（rejection AC4-2 describe，:470）随套件全绿。
**测试合计**：pass 17 + ticket 24 + rejection 24 + origin 112 + socket 14 + webapp-proxy 85 + template 15 = 291 全绿。

---

## 遗留

- #416 / #405 / #425 三张 BLOCKED-GAP 的缺口描述见上，建议各开专项派发；#405 与 #427 的边界互锁（放宽应用 cookie 时保 pass 剥离与 fail-safe）已在两票票面写明，专项实施时直接引用。
- `server/tests/craft-webapp-template.test.ts` 上一批 +5 行断言保留未动。
- 本批改动全部留在未提交区（无提交/推送授权）。
