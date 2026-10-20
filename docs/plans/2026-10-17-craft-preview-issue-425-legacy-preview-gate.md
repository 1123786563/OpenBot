# Issue #425 实现拆解 — legacy 同源预览的部署级开关与风险可见性

- Issue：#425（`ready-for-agent`，覆盖 **AC1 例外收口** + **AC7**，关联 D10/#367）
- Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`（D10）
- 代码基线：`origin/main` = `44754feb`（本文件所有行号对该 SHA 有效）
- 编排：Superpowers（`executing-plans` + `test-driven-development` + `requesting-code-review`）；设计已由 #403 决策门与审核报告锁定，本文件只拆 HOW

## 0. 前置与工作树纪律

1. **执行前必须把工作树推进到含实现的 main**。用户工作树当前在 `ce1d9ce1`，`server/src/craft/preview-origin.ts` 等文件不存在，本票无法执行。推进方式由用户决定（本地有未推送提交与暂存的 bifrost-5 改动）。
2. 独立 worktree（如 `impl-425-legacy-gate`），周期性 commit、不 push（沿用 `docs/plans/tickets/craft-preview-origin/manifest.json` 的全局约束）。
3. **不得与 #427 并行**：两票同写 `server/src/craft/webapp-proxy.ts`（#425 改 `proxyWebapp` 与 `resolveWebappHmrUpgrade`；#427 改 `resolvePreviewWebappHmrUpgrade` 的门读取），且都动 `CraftConfig`。按 `AGENTS.md`「可写文件不重叠才并行」，串行执行，建议本票先行（安全暴露收口优先）。

## 1. 为什么要四腿，不是两腿（拆解依据）

现状事实：legacy 会话的**同源预览有四个独立服务端面**，只关 `webapp-info` 是无效的——已打开的 iframe 与直接输入 URL 都能继续工作：

| 面 | 位置 | 现状 |
|---|---|---|
| 地址产出 | `webapp-proxy.ts:794-880`（`webapp_url: legacyWebappPreviewPath(sessionId)` @:870） | 总是返回相对旧路径 |
| HTTP 服务 | `app.on([...WEBAPP_METHODS], "/sessions/:sessionId/webapp/:path{.+}", proxyWebapp)` @:1029 + 裸挂载 @:1032 | 仍注册，带平台 cookie 即服务 |
| HMR 升级 | `WEBAPP_HMR_PATH` @:1114 + `resolveWebappHmrUpgrade` @:1175 | 仍回答 legacy 升级 |
| 换票 | mint 路由对 legacy 返回 409（`PREVIEW_TICKET_LEGACY_ERROR` @:139，判定 @:623-648） | 已拒绝，本票应保持 |

风险成立的原因：legacy 形态下 `WEBAPP_DEV_CSP` 的 `connect-src 'self'` 里 `'self'` **就是主站 origin**，面板又带平台 cookie iframe，所以生成代码可以以用户身份读写平台 API（正是 #358 要修的问题）。

## 2. 任务表

| ID | 任务 | 写范围 | 完成定义（RED→GREEN） |
|---|---|---|---|
| T1 | 配置面：新增 `legacyPreviewEnabled`（`boolEnv` 模式，紧邻 `webappProxyEnabled`） | `server/src/craft/config.ts`（字段声明参照 :203 区、解析参照 :469 区）、`.env.example` | RED：`craft-config.test.ts` 断言默认值与显式 `false` 的解析；GREEN：通过 |
| T2 | 原因常量：新增可展示关闭文案常量（不复用 `PREVIEW_PASS_REFUSAL`，语义不同） | `webapp-proxy.ts` 常量区（:139 旁） | RED：文案含「旧版预览与平台同源」+「重建 web app」两条信息；GREEN：通过 |
| T3 | `webapp-info` 关闭态：legacy 分支返回 `webapp_url:null` + 关闭原因，形状与 `previewOriginClosedReason`（:954）同构 | `webapp-proxy.ts:794-880` | RED：`craft-webapp-proxy.test.ts` 断言 legacy + 开关关 → `null` + 原因 + `webappGeneration` 仍为 `"legacy"`；GREEN：通过 |
| T4 | **服务腿**：两条 `proxyWebapp` 注册在关闭时拒绝，用 `refuseResponse(request, msg, 503)`（`server/src/craft/refusal.ts:21`，已具备 JSON/HTML 双形状），且判定必须在 `requireUser`（:550）之后 | `webapp-proxy.ts:967-1033` | RED：关闭时 `GET/POST /sessions/<legacy-id>/webapp/...` 得 503 且**不拨上游探针**（附着模型不回退为拉起进程）；未鉴权调用者仍得 401，不因本开关泄露会话存在性；GREEN：通过 |
| T5 | **HMR 腿**：`resolveWebappHmrUpgrade` 在关闭时拒绝，拒绝形状与该函数既有 401/503 一致，且发生在 `server.upgrade` 提交之前 | `webapp-proxy.ts:1175` 起 | RED：`craft-webapp-hmr.test.ts` 加 legacy 关闭用例（含「refusal 在 upgrade 之前」的可观察断言）；GREEN：通过 |
| T6 | 换票腿**验证为 no-op**：确认关闭态下 legacy 仍走 409、`unknown` 仍走 503（`fix-ocr26 #8`），不被本开关改变 | 无写操作，产出为测试 + 票面记录 | RED：断言两条既有语义不变；GREEN：本就成立 → 记录为「经测试确认的 no-op」 |
| T7 | 前端可见性：`legacyNotice` 文案补风险表述；新增关闭态展示（沿用 `closedReason` 的短路形状，见 :863-866 优先于 iframe 的既有分支） | `app/src/components/craft/output-panel/preview-tab.tsx`（:1172 展示处、:811-814 的代际判定 `const legacy`）、`app/src/locales/zh-CN/craft.json:33`、`app/src/locales/en/craft.json:33` | RED：`craft-preview-tab.test.tsx` 断言「关闭态不换票、不渲染 iframe、展示原因」；GREEN：通过 |
| T8 | 文档：`reference/craft-preview-origin.md` 存量会话一节（:153 起）写入风险、开关变量名、默认值取舍理由、收敛办法（重建 app 会由模板拷贝写 `.webapp-generation` 标记 → 翻转为 current，判定见 `webapp-generation.ts:103`） | `reference/craft-preview-origin.md` | 人工清单：风险、开关、收敛三条齐备 |
| T9 | 回归门禁与证据 | — | 见第 3 节全绿；票面 AC 勾选以测试名为据**不算** |

## 3. 门禁（合入前必须全绿）

```
cd server && bunx tsc --noEmit                 # 基线 exit 0
bun test server/tests/craft-webapp-proxy.test.ts        # legacy 相关 62 行断言在此
bun test server/tests/craft-webapp-generation.test.ts   # 34 行
bun test server/tests/craft-webapp-hmr.test.ts
bun test server/tests/craft-preview-origin.test.ts server/tests/craft-preview-rejection.test.ts server/tests/craft-preview-ticket.test.ts   # 基线 140 通过
bun test app/tests/craft-preview-tab.test.tsx            # 基线 79 通过
bunx biome lint <本票改动的文件>
```

**基线数字**（供复核）：ticket/origin/rejection = 140 pass；webapp 六件套 = 217 pass；preview-tab = 79 pass。

## 4. 设计决定与取舍（需实现者遵守）

- **默认值取 `true`**：直接默认关闭会让存量会话当场不可用（AC7 的「不回归」优先）。本票的目的是**给部署方选择权**，不是替所有部署做决定。取舍写进票面。
- **拒绝形状选 503 不选 404**：关闭是功能状态，不是资源不存在；`refusal.ts` 默认形状即 503，且与 `webapp-proxy` 既有拒绝一致（全局约束「拒绝形状与既有预览代理一致 401/404/503」）。
- **不得触碰 current 代际任何路径**：本票只加 legacy 分支的判定。`#427` 之后通行证语义会变，两票改动点必须不重叠（见第 0 节第 3 条）。
- **不要把开关做成「静默不可用」**：AC7 要求「可用 **或** 明确给出不可用原因」，两者必有其一。T3/T4/T5/T7 四条都必须能向人展示原因。

## 5. 风险

1. **只关 `webapp-info` 造成假收口**（本票最大风险）：T4/T5 是必须项，不是可选加固。若时间要砍，砍 T7 文案，不砍 T4/T5。
2. 未鉴权探测差异：若把开关判定放在 `requireUser` 之前，未登录者可用 503/401 差异枚举会话；T4 的 RED 用例专门钉这条。
3. `craft-webapp-proxy.test.ts` 现含 62 行 legacy 断言，改默认值或改拒绝形状会连带红一片 —— 先跑基线记录，再逐条甄别是真回归还是断言陈旧。**不要为了让测试绿而放宽开关语义**。
4. 前端 `preview-tab.tsx` 的 legacy 直连入口有一整套 URL 形状防御（协议相对、反斜杠转义、tab/CR/LF 剥离等 fix-ocr 系列）。T7 只改文案与关闭态分支，**不要顺手重构那块防线**。

## 6. 与票面 AC 的映射

| #425 票面 AC | 由哪些任务满足 |
|---|---|
| 旧会话行为明确（可用 / 不可用 + 原因），二者必有其一且被文档化 | T1–T5、T7、T8 |
| 不出现「旧应用在新形态下静默 404」的中间态 | T3、T6（+ 既有 `unknown→current`、mount 交叉校验保持） |
| 判定逻辑有测试并写明理由 | T1、T3、T4、T5（信号为显式标记文件，理由见 `reference/craft-preview-origin.md:158-187`） |
| 用户可见提示与文档一致 | T7 ↔ T8 交叉核对 |
