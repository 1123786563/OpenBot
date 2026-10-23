# Issue #427 实现拆解 — preview 通行证改为不透明 token + 索引

- Issue：#427（`ready-for-agent`，覆盖 **AC4/D9** 的轮换能力补强）
- Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`（D4/D9）
- 代码基线：`origin/main` = `44754feb`（行号对该 SHA 有效）
- 编排：Superpowers（`test-driven-development` → `requesting-code-review` → `verification-before-completion`）

## 0. 前置与工作树纪律

1. 工作树必须先推进到含实现的 main（当前用户工作树 `ce1d9ce1` 缺本波实现）。
2. 独立 worktree（如 `impl-427-opaque-pass`），周期性 commit、不 push。
3. **不得与 #425 并行**（同写 `server/src/craft/webapp-proxy.ts` 与 `CraftConfig`）。建议顺序：#425 先，本票后。
4. 与 #405（并发票集，让生成应用使用自己的 cookie）**不冲突但相邻**：#405 放宽的是应用自有 cookie 透传，本票改的是平台通行证自身的值形态。两票都动 header hygiene 时，必须保住 `webapp-proxy.ts:244-265` 对 `cookie` 的剥离与 :278-286 对 `set-cookie` 的不下发。

## 1. 改造面实测（这是本票工作量的真实来源）

通行证只有 **1 个植入口 + 3 个读取门 + 1 个解析器**，接缝很窄：

| 角色 | 位置 | 现语义 |
|---|---|---|
| 植入口 | `preview-origin.ts:765` `"set-cookie": previewSessionCookieHeader(sessionId, entryRoot)` | **值就是明文 sessionId** |
| HTTP 门（流量） | `preview-origin.ts:779` | `holdsPreviewSessionPass(sessionId, request)` |
| 兑换前置门 | `preview-origin.ts:700` | 同上（持 pass 者不再兑换，`fix-ocr22 #1`） |
| HMR 门 | `webapp-proxy.ts:1273`（`resolvePreviewWebappHmrUpgrade`） | 同一导出判定，两处手工纪律合一 |
| 判定实现 | `preview-origin.ts:95-102` + 解析器 :813-821 | 遍历全部同名候选，任一 `=== sessionId` 即放行 |
| header 边界 | `preview-ticket.ts:167-196`（path 白名单 :176、value 白名单 :187） | value 限 `[A-Za-z0-9_-]{1,128}`，不合规**静默折叠为空** |

测试面（`grep -c` 实测）：`craft-preview-origin.test.ts` 26 行、`craft-preview-ticket.test.ts` 14 行、`craft-preview-rejection.test.ts` 9 行、`craft-webapp-hmr.test.ts` 5 行、`craft-webapp-proxy.test.ts` 5 行 = **59 行断言会随值形态变化**。这是本票主要工作量，不是索引逻辑本身。

## 2. 设计契约（实现者按此执行，勿重新设计）

- **token 形态**：`randomBytes(32).toString("base64url")` → 43 字符，落在既有 value 白名单 `[A-Za-z0-9_-]{1,128}` 内（`-`/`_` 是该字符集成员），**不需要放宽白名单**。放宽白名单是本票要避免的副作用。
- **索引**：`token → sessionId`，一会话**只保留一个活跃 token**（再兑换即覆盖 = 天然轮换）。条目上界 = 会话数，与 label registry 同形（`preview-origin.ts:477` 的既有取舍，`ponytail` 注释已记录）。
- **门语义**：从「候选值等于本 host 解析出的 sessionId」改为「候选值等于本 host 解析出的那个会话的**活跃 token**」。跨会话性质不变：A 的 token 打不开 B 的 host。
- **必须保住的 fail-safe 折叠**（`fix-ocr23 #6` / `fix-ocr24 #6`）：白名单不合规 → 折叠为空 → 空值永不等于任何活跃 token → 恒 401。改造后这句仍成立，但 `preview-ticket.ts:181-186` 与 :188-194 的**注释文字**目前写的是「can never equal a session id」，语义变更后必须同步改注释，否则注释说谎。
- **门不得成为唯一权威**（保持现状）：会话删除/归属变更仍由 `servePreview` 的 `findSessionById`（by-id、不 bump 活动时钟）404 承担。**不要**把每请求改为 store 重查——那会引入活动时钟污染（`preview-origin-live` 探针正是为此改用 `findSession` 无 bump 版本，见 `webapp-proxy.ts:681-700` 的 `fix-ocr18 #1`）与每请求 DB 开销。
- **重启语义**：索引为内存表，重启即清空 → 与 M-2 同形（恢复须经主站重进，重进即重铸 token）。**不新增故障类别**，但要在文档写明「重启后通行证与 label 一起失效」。
- **不记日志**：token 与票值同属 bearer credential，唯一合法出现位置是 `Set-Cookie`。`refuseResponse` 的双形状 + `no-store` 纪律（`fix-ocr27 #7` / `fix-ocr28 #6`）保持不变。
- **R-9 / fix-ocr20 #3 / fix-ocr23 #7 三条既有纪律原样保留**：dev 形态 Path=`/<label>` 作用域、遍历全部同名候选（深路径阴影不得遮蔽）、`entryRoot` 单读两用。

## 3. 任务表

| ID | 任务 | 写范围 | 完成定义（RED→GREEN） |
|---|---|---|---|
| T1 | 先改测试基线：把 59 行「断言值 == sessionId」的期望改为「断言值 ≠ sessionId 且等于索引中的活跃 token」，保持其余断言不动 | 第 1 节列的 5 个测试文件 | RED：改造后测试全红，且红点集中在「植入了 sessionId」这一事实；GREEN：暂不可达（本任务只建立靶） |
| T2 | 索引模块：新增 pass store（建议 `server/src/craft/preview-pass.ts`，与 `preview-ticket.ts` 同层，理由：票据表与通行证表都是短命内存 TTL 结构，但不该共用一个模块——票据是单次消费的**入场券**，通行证是会话级**存续凭据**，生命周期不同） | 新文件 + `preview-ticket.ts` 的导出边界 | RED：单测——铸 token 即登记、再兑换覆盖、未知 token 查不到、空值查不到、不记日志；GREEN：通过 |
| T3 | 植入口改造：兑换成功时铸 token 并登记，`Set-Cookie` 改用 token；保持 `entryRoot` 单读 | `preview-origin.ts:741-768` | RED：观测 Set-Cookie 值为 43 字符 base64url、无 `Max-Age`/`Expires`、含 `HttpOnly; SameSite=None; Secure`、dev 形态 `Path=/<label>`；GREEN：通过 |
| T4 | 门改造：`holdsPreviewSessionPass` 改为查索引比较；三个调用点（:700、:779、`webapp-proxy.ts:1273`）语义不变、签名不变 | `preview-origin.ts:95-102`（+ 调用点零改动为目标） | RED：他人 token 401、无 pass 401、深路径阴影不遮蔽、覆盖旧 token 后旧值失效；GREEN：通过 |
| T5 | 注释与文档同步：`preview-ticket.ts:181-194` 的折叠理由、`preview-origin.ts:738-740` 的 `ponytail` 注记、`reference/craft-preview-origin.md` 的进入流程（:42-56）与重启空窗（:84）两节 | 上述三处 | 人工清单：不留任何「通行证值是 session id」的表述 |
| T6 | 边界确认（no-op 验证）：`preview-origin-live` 探针读 registry 不读凭据（`webapp-proxy.ts:681` 起）、hostname/label 派生不受影响（`preview-origin.ts:230-239`、:510-534） | 无写操作，产出为测试与票面记录 | RED：断言二者行为不变；GREEN：本就成立 → 记录 |
| T7 | 真实 socket 复验：把审核期 harness 的 cookie 相关断言在 token 形态下重跑一遍 | `server/tests/craft-preview-socket.test.ts`（若 #416/#422 尚未落地，则临时在本票 worktree 内验证并在票面附命令与输出） | 断言：上游看不到 `cookie`/`authorization`/`origin`；通行证值非 sessionId；门在 upgrade 提交前拒 |
| T8 | 回归门禁 | — | 第 4 节全绿 |

## 4. 门禁

```
cd server && bunx tsc --noEmit
bun test server/tests/craft-preview-ticket.test.ts server/tests/craft-preview-origin.test.ts server/tests/craft-preview-rejection.test.ts   # 基线 140
bun test server/tests/craft-webapp-hmr.test.ts server/tests/craft-webapp-proxy.test.ts                                                     # 基线并入 217
bun test app/tests/craft-preview-tab.test.tsx                                                                                               # 基线 79
bunx biome lint <本票改动的文件>
```

**AC3/AC4 的并发与拒绝语义必须重跑确认未退化**：并发兑换恰一成功、重放 401、注入时钟过期、他人会话票 401 —— 这些都发生在票据层，但门改造若出错会把它们全部洗掉。

## 5. 风险

1. **静默放宽白名单**：最省事的实现是把 value 白名单改成「任意」，那等于把 `fix-ocr23 #6` 关掉的属性注入面重新打开。token 选 43 字符 base64url 正是为了不动白名单。
2. **注释说谎**：多处注释的推理依赖「空值永不等于 sessionId」。改 token 后结论仍成立，但措辞必须跟着换（T5），否则下一轮实现者会按旧措辞做错误判断。
3. **把门改成每请求 store 重查**：会引入活动时钟污染与每请求 DB 开销，破坏 `fix-ocr18 #1` 已建立的纪律。第 2 节已禁止。
4. **测试改造与实现改造混在一次提交**：T1 的靶必须先立，否则「测试绿」无法区分是被改对还是被改松。分开 commit。
5. 轮换能力的真实收益有限（通行证本就是会话级、关闭浏览器即失效）。**不要**为凑功能再造登出/强制失效接口——票面目标只是「不泄露内部标识 + 具备轮换能力」。

## 6. 与票面 AC 的映射

| #427 票面 AC | 任务 |
|---|---|
| 兑换种不透明 token，`token → sessionId` 索引，生命周期与 D9 会话级 cookie 一致且重启行为明确 | T2、T3、第 2 节重启语义、T5 |
| 保住 fail-safe（未知/空值 ⇒ 恒 401），不得变成「查不到就放行」 | T2、T4 |
| 两条 header 白名单继续覆盖新值 | 第 2 节 token 形态、T3、风险 1 |
| R-9 dev 形态 `Path=/<label>` 并存语义不变 | T4、T7 |
| `fix-ocr20 #3` 同名候选遍历不变 | T4 |
| token 与票值都不进日志、不回显在错误响应 | T2、T4、第 2 节不记日志 |
| 轮换语义有文档说明 | T5 |
