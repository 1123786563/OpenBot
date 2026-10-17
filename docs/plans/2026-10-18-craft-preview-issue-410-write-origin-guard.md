# Issue #410 — 主站 cookie 认证写接口拒绝 preview Origin（实现与证据记录）

- 票面：<https://github.com/1123786563/OpenBot/issues/410>（Parent #358，Priority P0，AC: AC1，Related #362，Dependencies CP-03）
- 基线提交：`bbea87ba`（本轮全部证据都在该提交的工作树上产出；改动尚未提交）
- 设计事实源：`docs/specs/2026-10-15-craft-preview-origin-design.md`（AC1/D1/D3/D5/D7）、`docs/plans/2026-10-17-craft-preview-cp-wave-index.md`（CP-03 → #410 的映射，D-5 落点）
- 记录时间：2026-10-18

## 1. 这轮补的是哪一层

生产 preview 是主站的子域，所以它与主站**同 site**：SameSite 不会阻止主站会话 cookie 随预览页发起的请求一起到达主站；CSP（#365/#367 那条线）只是浏览器侧防线，可以被它所要保护的页面本身放宽。票面要的是服务端纵深：cookie 被真正消费的那一侧，自己再认一次 Origin。

本轮之前代码里**不存在**这条判定：`server/src/craft/preview-origin.ts` 只有基于 **Host 头**的认领（`handlesRequest`）与基于 Host 的升级门（`samePreviewOrigin`，#363 的 CSWSH 修复），主站 `/api/craft/**` 的写路由对 **Origin 头**不做任何判断。

## 2. 落点与判定口径（用户裁决记录）

两条口径由用户在本轮开工前选定，实现按此执行：

1. **白名单严拒（票面口径）**：非安全方法带 Origin 时，只放行「请求自身 Host 同源」与「受信 origins」，其余一律 403 —— 包含 preview 命名空间，也包含任何其它来源。
2. **dev 形态记录为已知不可判定，不额外处理**：空模板下预览地址是 `http://127.0.0.1:<server port>/<label>`，会话在 **path label** 上，而 Origin 头永不含 path，因此它与主站自身 Origin 同形；拒绝它等于拒绝主站自己的写请求（fix-ocr3 那类「主站全灭」形状）。

判定顺序（任一步 fail closed）：

| 步骤 | 条件 | 结果 |
| --- | --- | --- |
| 1 | 方法是 GET/HEAD/OPTIONS | 不经本门（读面归 CORS + preview pass；预检必须能到 CORS） |
| 2 | 无 Origin 头 | 放行（CLI / native / 服务端内部调用不是「可被骗的文档」） |
| 3 | Origin 落在 preview 命名空间 | 403（**先于**白名单判定：把 preview 基座误写进 `TRUSTED_ORIGINS` 也照样拒） |
| 4 | Origin 归一化后 == 请求自身 origin，或 ∈ 受信 origins | 放行 |
| 5 | Origin 不可解析 / 不透明（`null`、`javascript:`、垃圾串） | 403 |
| 6 | 其余 | 403 |

两侧统一走 `normalizedOriginOf`（尾点折叠、端口仅在存在时携带、忽略 path/query/hash），避免用裸字符串相等比较 —— 与 `samePreviewOrigin`（#363）共用同一份归一化，不再有三份拷贝。

## 3. 代码改动

- 新增 `server/src/craft/write-origin-guard.ts`：`createCraftWriteOriginGuard`，导出固定拒绝句 `CRAFT_WRITE_ORIGIN_REFUSAL`。
- `server/src/craft/preview-origin.ts`：
  - 抽出**一份** host 认领 `claimsPreviewHost` + `effectivePortOf` + `parseOriginUrl`/`normalizedOriginOf`；
  - `handlesRequest` 的 host 分支与 dev 分支改为调用该共享判定（行为不变，含 fix-ocr22 #2 的 localhost 端口收窄与 apex 不认领、fix-ocr16 的尾点折叠、#361 终审的 :80 有效端口）；
  - `samePreviewOrigin` 改为通过 `normalizedOriginOf` 比较（行为不变，三种不透明/不可解析形状仍是拒绝而非抛）；
  - 新增 `PreviewOrigin.claimsOrigin(origin)` —— 与 Host 侧同一个认领规则，判 Origin 头；dev 形态一律不认领并在接口注释里写明原因。
- `server/src/craft/routes.ts`：`CraftRoutesDeps` 增 `previewWriteTrustedOrigins` / `previewOriginClaimsOrigin`；门挂在 `app.use("*", requireUser)` **之前**、两个 relay（`/mcp/:serverId`、`/kb-search`）注册**之后** —— 即按 Hono 的注册序匹配：sandbox 侧带 session tag 的 relay 不受影响，cookie 认证面在触库与出身份之前就被拒。
- `server/src/config.ts`：抽出 `trustedBrowserOrigins(config)`（`TRUSTED_ORIGINS` + `OPENBOT_APP_URL`，只保留 http(s) origin）。
- `server/src/app.ts`：CORS 块改用同一函数，注释点明「CORS 与写接口不可能对『谁受信』给出两个答案」。
- `server/src/index.ts`：装配处传 `craftPreviewOrigin.claimsOrigin` 与 `trustedBrowserOrigins(config)`。

## 4. 逐条 AC 状态与证据类型

证据类型口径：**单测/装配测** = 本轮真实跑过并通过；**运行时** = 真实 server + 真实浏览器；**blocked** = 本轮无法产出。

| 票面 AC | 状态 | 证据 |
| --- | --- | --- |
| 带 preview Origin 的 credentialed POST → 403 | 单测+装配测（PASS） | `server/tests/craft-preview-origin-guard.test.ts`：`AC1 — 带 preview Origin 的 credentialed POST → 403`（单元层，真实 `createPreviewOrigin` 铸出的地址）；`preview Origin 的写请求在 requireUser 之前就被 403（不是 401）`（`createCraftRoutes` 装配层，证明注册顺序） |
| 主站自身 Origin → 原行为 | 单测+装配测（PASS） | `主站自身 Origin（受信列表）→ 原行为`、`Host 同源 Origin → 原行为`、装配层 `受信 Origin 仍走原认证判定（401）` |
| 无 Origin 的 internal/native 调用 → 原行为 | 单测+装配测（PASS） | `无 Origin（internal / native / CLI）→ 原行为`、装配层 `无 Origin 仍走原认证判定（401）` |
| 不误伤现有测试与 Server Actions 自身请求 | **部分**，运行时未证 | 「不误伤现有测试」：本轮跑过的 craft 套件全绿（见 §5），且全仓 `server/tests` 中无任何测试向 craft 路由发送 Origin 头（`grep` 核实）；relay 不受影响有装配层 pin（`sandbox 的 MCP relay 在门的上一层…`）。「Server Actions 自身请求」属 #414（P1），本轮只在逻辑上覆盖「同 Origin/受信放行」，**没有**真实浏览器跑过 Next Server Action |
| 有测试覆盖 Origin 缺失/伪造/子域形状 | PASS | 缺失（第 3 行）、伪造（`伪造与不透明 Origin…`、`其他 Origin → 403`、后缀/前缀伪装四条）、子域形状（`preview 命名空间里的任意深度子域同样 403`、`localhost 形态…`、`claimsOrigin` 全部用例、尾点与默认端口拼写用例） |
| 票面 Tests 指定的文件 | 以新文件交付 | 票面写 `server/tests/craft-preview-rejection.test.ts` **或新 middleware 测试**；该文件已被 #358/#362 那条线占用于「preview 主机自身」的拒绝面，本票是主站侧的 Origin 门，故新建 `craft-preview-origin-guard.test.ts` |
| 拒绝日志不含 cookie/ticket | PASS | `日志与响应体都不含 cookie / ticket 值`（断言日志条目与响应体都无 cookie 值、无 query 里的 ticket 值，且只记 method/path/归一化 origin/verdict） |

本轮额外补的回归 pin（因为 §5 的阻塞）：`共享归一化与 host 认领: 重构后的回归 pin` 6 例，直接钉住被改动的 `samePreviewOrigin`、`handlesRequest`（host + dev 两形态）、`resolvePreviewRequest` 的未注册 label 404。

## 5. 本轮实际跑过什么（含阻塞，如实记录）

已跑并通过：

- `bun test server/tests/craft-preview-origin-guard.test.ts` → **26 pass / 0 fail / 71 expect()**（最终态，含回归 pin）。2026-10-18 01:21（本地时间，UTC 17:21）复跑同一文件仍为 26 pass / 0 fail，此刻该文件的 import 仍是 `bun:test`；§5 的阻塞只影响那 42 个被 codemod 改写的文件，不影响本票测试的可复现性。
- 迁移 codemod 落地前（2026-10-18 00:31 前后，同一工作树）：
  - `craft-preview-origin` + `craft-preview-pass` + `craft-preview-rejection` + `craft-preview-ticket` + `craft-routes-assembly` + `craft-mcp-relay` + `craft-kb-search-relay` → **199 pass / 0 fail**；
  - `craft-webapp-hmr` + `craft-webapp-proxy` + `workshop-preview` → **133 pass / 0 fail**；
  - 当时新测试为 RED→GREEN：实现前 `Cannot find module '../src/craft/write-origin-guard'`，实现后 20/20。
- `bunx biome check` 对新增两个文件：0 finding（已 `--write` 归一格式）。被改动文件里剩下的 finding（`app.ts` 的 organizeImports、`config.ts:37` 的 noUnusedImports、`index.ts` 的 noConsole/noNonNullAssertion）经行号核对均在我未触碰的区域，属 HEAD 既有 debt。

**阻塞（不是通过）**：

- 并行会话正在把 `server/tests/**` 全量迁到 `e2e` runner（codemod 把 `bun:test` 的 import 改写成 `../../tests/support/e2e-compat`）。截至本记录，`server/tests/craft-*.test.ts` 43 个文件里 **42 个已被改写**，只剩本票新建的那份仍是 `bun:test`。后果：
  - `bun test` 对那 42 个文件全部报 `CollectionError: describe() can only be called while a test module is being collected by the e2e runner`；
  - `bunx e2e run --config e2e.unit.config.ts server/tests/craft-preview-rejection.test.ts` 报 `CONFIG_NOT_DETERMINISTIC` + `WORKER_INIT_FAILED`（worker 起不来，24 个用例 skipped）。
  - 因此**「craft 家族全量回归」这一条此刻无法复现**，只能引用上面对迁移前状态的实测记录；这也正是我给重构的共享判定补 §4 最后一段那些 pin 的原因。
  - 本票文件被同一 codemod 改写过一次（`import … from "../../tests/support/e2e-compat"`），已改回 `bun:test` 以便 `bun test` 复现；若后续按仓库新约定统一到 e2e，断言本身与 runner 无关（`e2e-compat` 转发 `describe/test/expect` 并补齐 `toThrow` 等单元 matcher），迁移后应能在 `e2e run` 下原样跑。
- 运行时证据缺失：本轮没有起真实 server 做真实浏览器的 same-site 写请求验证。票面 AC1 的「浏览器里真的带 cookie 打主站拿到 403」目前只有 HTTP 层测试形状支撑；same-site 浏览器 case 本就归 CP-11/#416（e2e 工具前置，且 #416 依赖 #433）。
- 类型检查：`cd server && bunx tsc --noEmit` 于 2026-10-18 01:2x 完成，**共 10 条 error，全部不在本票改动的文件里**：`../tests/support/e2e-compat.ts` 4 条、`../tests/support/bun-compat.ts` 1 条、`src/desktop-telemetry.test.ts` 2 条、`src/kb/{tasks/document-process,infrastructure/qdrant/collections,application/repository/retriever/qdrant/roundtrip}.test.ts` 各 1 条（`describe.skipIf`/`test.each` 在迁移中间态下的类型缺口）。本票的 `src/craft/*`、`src/app.ts`、`src/config.ts`、`src/index.ts`、`tests/craft-preview-origin-guard.test.ts` 零 error。

## 6. 已知缺口与后续衔接

1. **dev 形态不可判定**（§2 裁决 2）：不是「已防护」，是「该形态下 Origin 层无从判定」。若要给 dev 也上服务端纵深，需要新的判据（例如换票侧写一个只与预览会话绑定的凭证头，或让 dev 形态也走独立主机），属新票范围，不应记进本票 AC。
2. **#414**（P1，验证并修复 preview origin 下的 Server Actions）与本门共用受信列表；若 #414 发现 Server Action 的 Origin 形状与 `TRUSTED_ORIGINS` 不一致，要回到 `trustedBrowserOrigins` 这一份列表上改，不要在本门里加特例。
3. **#419**（文档/证据收口）：本票没有改 `.env.example`。收紧后「浏览器可达的写接口需要 Origin 在 `TRUSTED_ORIGINS`/`OPENBOT_APP_URL` 里」是新部署约束，`.env.example` 的说明与本地 dev 端口示例应由 #419 一并补（本地跨端口 dev 若未列 `TRUSTED_ORIGINS`，主站写请求会拿到 403）。
4. 多副本部署：本门无状态，不受 preview origin 注册表的内存态（M-2）影响。

## 7. 待补

- 真实 server + 真实浏览器的 same-site POST 证据（403 落在真实主站写接口上）：需与 #416 的 e2e 工具前置一起做，且要先解除 §5 的 runner 阻塞。
- 本票改动尚未提交；提交时只按 pathspec 加本轮 6 个文件（`write-origin-guard.ts`、`preview-origin.ts`、`routes.ts`、`config.ts`、`app.ts`、`index.ts`、新测试与本记录），工作树里另有数百个并行迁移改动，不得一并 stage。
