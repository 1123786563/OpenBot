# U01 独立 Review：Computer 活动分类、撤回和屏幕 hook（A05 / Issue #494）

- Reviewer：独立 reviewer（Task U01 质量关口；只读，除本报告外无写入）。
- 工作区：`.worktrees/upstream-openbot-update`（HEAD 3b4a7c68）。审查时间：2026-10-20。
- 对象：`after-tracked.diff` 中 4 个 U01 tracked 文件（`app/src/lib/computers/call.ts`、`app/src/lib/copilot/computer-activity.ts`、`app/src/routes/_authed/_app/channel/$channelId.tsx`、`docs/verification/e2e-bun-suites.json`）+ 3 个 untracked 新文件（`use-auto-watch-screen.ts`、`auto-watch-screen.test.tsx`、`computer-screen-announcement.test.ts`）。diff 中其余 server/* 改动属 S01–S04，不在本次范围。
- 结论：**Spec compliance pass，Code quality pass**。Findings：1 Low（测试覆盖缺口，实现者已如实披露）、4 Info/Obs。无 Medium 及以上。

## 1. Spec §3 逐条对照（独立复核源码后判定）

1. **显示动作显式路径集合；文件/shell/未知请求不据猜测开屏** — **满足**。`call.ts` 以 `ON_SCREEN_PATHS`（/navigate、/click、/type、/key、/scroll）许可清单实现；`reportComputerActivity` 仅对清单内路径调用。我独立 grep 了全部 `callComputer` 调用点：computer-tools.tsx 9 处（/type:339、/click:381、/key:432、/control/secret:480、/files/list:592、/files/read:639、/exec:696、/files/write:782、/scroll:842）、handoff.ts 4 处（/snapshot:107、/control/request:213、/navigate:239、runBrowserRead 的 /read|/snapshot:277）——5 个真实显示路径与 allowlist 精确吻合，无遗漏；/files/download server 路由存在（routes.ts:703）但 app 无调用点，测试仍钉住其静默。测试 `computer-screen-announcement.test.ts` 前两个用例钉住文件/shell/未知（/control/secret、/read、/snapshot、/hover 代表未知）全部零 announcement。
2. **每次公告独立标识；拒绝只撤回相同标识打开的面板；保留手动面板与已显示有效动作** — **满足**。`announcement` 为模块级单调计数、逐次分配且返回；403 仅撤回本调用拿到的 announcement；手动打开的面板 `openedFor=null`，撤回永不及于它；先前有效动作的面板持有自己的 announcement，后续他人 403 不影响（hook 测试"other announcement leaves the pane alone"钉住）。
3. **网络失败/500/取消不假定未执行** — **满足**。仅 `response.status === 403` 撤回；catch（网络错误）、500、AbortError→`stopped:true` 均不撤回。测试四个用例（网络/500/abort/成功）各自断言 announcement 已发生且 withdrawals 为空。
4. **保留 10 秒静默 epoch 启发式并明示限制** — **满足**。`computer-activity.ts` 头注明示 "a heuristic about silence, not a server run id"；hook 头注同。同 Bot 连续同 epoch、换 Bot 新 epoch、静默 >10s（`Date.now` mock）三用例齐备；用户关闭后同 epoch 抑制、下一 epoch（+11s）可再开均由 hook 测试钉住。
5. （§3 第五条 connector/browser 聚合属 UP07，正确不在本任务范围。）

## 2. up05 六条 criteria

1. 显式路径集合，文件/shell/未知不开屏 — 满足（见上）。
2. 独立标识、仅明确拒绝撤回自身、网络失败/500/abort 不假定未发生 — 满足（见上）。
3. 不关闭用户手动打开、早前有效动作、设置或 Workshop 面板 — **行为满足，但路由级组合无测试钉住（F1，Low）**。hook 层 `busy=true` 不抢占已有用例；路由把 `busy: isSettingsOpen || isWorkshopOpen` 传入（$channelId.tsx:71）是本次 workshop 修复的关键一行，仅静态核对，无任何测试能在该行被删时变红（详见 F1）。open() 多清 `workshop` flag 因 busy 含 workshop 实际不可达（防御性，无害）。
4. epoch 启发式沿用具限制声明；关闭后同 epoch 内不重开 — 满足。
5. 切 Bot/卸载清理订阅、迟到事件不影响新范围 — 满足。4 条用例（换 Bot 后旧 announcement/withdrawal 均无效、新 Bot 正常开、卸载后双通道静默）。关于计划 I1"重置引用"：`runEpoch/dismissedEpoch/openedFor` refs 不随 botId 显式清零（与上游逐字一致），但 epoch 全局单调且 announcement 每次分配全局唯一 id，撤回又按 botId 过滤——跨 Bot 撞号不可达，可观察行为层面等效于重置（validator Info-1 论证成立，我独立推演未找到反例）。
6. 窄屏与键盘关闭、手动入口继续可用 — **既有相邻套件覆盖**：detail-panel / live-screen-keyboard / live-screen-app-shortcuts / computer-control-button 均在我亲跑的驱动轮 part 1–4 内绿；`DetailPanel onClose → show(null)` 与 `ComputerChatControls onOpenChange` 接线逐字未动（diff 证实）。channel 路由 pane 关闭的 URL flag 路径本身无专项测试——BASE 即如此，非本任务引入，并入 F1 记录。

## 3. Code quality

- **Ruling U01-R1 执行 — 到位**。代码与裁决完全一致（5 路径 allowlist、未知静默）。`call.ts` 的 "A PERMIT LIST, and deliberately so" 注释质量高：说明与上游 fail-open 语义的分歧、为何（"a wrong pane is a lie about what is happening"）、失败模式权衡（漏登记 = 该开不开而非无中生有的 pane）、以及对后来者的维护规则（"Browser display paths added later must be added here"）。分歧留痕在决策点本身，无需读 ledger 即可被发现。
- **hook 与上游一致性** — 逐行比对 `evidence/upstream-sources/.../use-auto-watch-screen.ts`：逻辑完全一致，差异仅 `run→runEpoch`、`dismissed→dismissedEpoch` 重命名与 doc comment 增补 workshop 说明。本地化适配集中在路由（busy 含 workshop、open() 多清 workshop flag），与本地共享 pane 互斥语义吻合，属真实适配而非漏改。
- **403 撤回语义与上游逐字一致**（`response.status === 403 && announcement !== null`），AbortError→Stopped、网络错误 reason 均未改动。
- **callComputer 兼容性** — 签名 `(botId, path, init?, signal?)` 与返回 shape（ok/reason/refused/rule/staleRefs/humanHasControl/handoff/stopped）不变；`git diff HEAD --` 对 handoff.ts、computer-tools.tsx 为空（亲验），现有调用者零改动属实。
- **测试结构** — 两个新 suite 都经公共 seam 观察行为（callComputer + 事件订阅；renderHook + open/close 回调计数），不刺私有实现；每测试独立 bot 规避模块级 epoch 状态串扰；时钟 mock 局部且 try/finally 恢复。合理。
- **e2e-bun-suites.json 登记** — 我用 `scripts/lib/e2e-manifest.mjs` 的 `groupsOf` 对当前 flat 462 条独立复算：app/tests 全部 6 组与登记逐条一致；flat 460→462 恰为两个新文件、无删除、有序无重；两文件落位 part 1 / part 3 与报告一致；part 4 由 4→6，级联移位均为组边界移动，组大小全部 ≤24。

## 4. 独立复跑证据（我亲自执行）

| 命令 | 结果 | 与报告口径 |
|---|---|---|
| `bun test ./app/tests/computer-screen-announcement.test.ts` | 14 pass / 0 fail（31 expect） | 一致 |
| `bun test ./app/tests/auto-watch-screen.test.tsx` | 16 pass / 0 fail（23 expect） | 一致 |
| `bun test ./app/tests/computer-activity.test.ts` | 13 pass / 0 fail（15 expect），对 HEAD 零 diff | 一致，未削弱 |
| `bun test ./app/tests/computer-tool-refusals.test.ts` | 3 pass / 0 fail | 一致 |
| `bun run --filter app typecheck` | exit 0 | 一致 |
| `bunx biome format` 6 个改动文件 | 全部 exit 0；`e2e-bun-suites.json` exit 1 且 BASE 版本（HEAD，经 /tmp 临时文件核）同样 exit 1 | 一致，漂移系生成器 `JSON.stringify(payload, null, 1)` 风格、BASE 既有 |
| `E2E_BUN_ONLY=app/tests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts` | 6 组 selected/executed，5 pass 1 fail（127s）：part 1 ✓ 10.04s（含 auto-watch-screen）、part 2 ✓、part 3 ✓ 2.28s（含 announcement + activity 回归）、part 4 ✓、multitenancy ✓；ai-observability ✗ = `ai-observability-route-chain.test.tsx` 5/5 独跑仍红（`queryClient.ensureQueryData` undefined），另 admin-summary 仅共享进程红独跑绿 | 与两份报告及 ledger §7 既有红登记逐组吻合 |

## 5. 两份报告声明抽查

- 实现者 §2 全部行号引用（/navigate:239、/click:381、/type:339、/key:432、/scroll:842、files 三处、/exec:696、/control/secret:480、runBrowserRead handoff:107/277、computer-tools:272/291、routes.ts:702）逐一核对无误。
- 实现者 §3 用例数（14/16/13/3）与 expect 数（31/23/15）与我的复跑完全一致。
- 实现者"复算现有清单并验证逐组一致"——按其括注口径（app/tests part groups）成立；**全清单复算并不逐组一致**：`server/tests/multitenancy` 登记为 26+25 两组，生成器现行为产出 24/24/3（见 F2）。
- Validator §3"handoff.ts（5 处）与 computer-tools.tsx（8 处 + re-export）"计数不准：实际 call 表达式 handoff 4 处、computer-tools 9 处（见 F3）。其载荷声明（调用者零改动）经 git diff 独立证实为真。
- RED 阶段证据（缺导出/缺模块两条 fail）不可回放复跑（只读约束），但最终 import 依赖关系使该 RED 逻辑必然，采信文本留档（与 validator Info-4 同口径）。

## 6. Findings

| # | 严重度 | 描述 | 处置建议 |
|---|---|---|---|
| F1 | Low | **路由级 busy 组合与 pane 关闭 URL 路径无测试钉住**。`busy: isSettingsOpen || isWorkshopOpen`（$channelId.tsx:71）是 up05 criterion 3"Workshop 面板不被抢占"的落地行，删除 `\|\| isWorkshopOpen` 不会使任何测试变红；`DetailPanel onClose → show(null)` 的 URL flag 清理同样无专项测试（BASE 即如此）。hook 语义已被参数化用例钉住，缺口仅在路由组合这一层。实现者已在报告 §5 如实披露（"channel 路由 pane 关闭本身无既有专项测试"）。 | 不阻塞本任务。建议后续（V01 或独立小票）补一条渲染路由组件的用例：workshop 开 + 显示动作 → 面板不被抢占；及 show(null) 后 `watch` flag 清除。 |
| F2 | Info | **manifest 全量复算与登记不一致（BASE 既有，非 U01 引入）**。`groupsOf` 现行为对 `server/tests/multitenancy`（51 文件）产出 24/24/3 三组，登记文件为 26+25 两组（git show HEAD 对照：BASE 即 26+25）。U01 diff 未触碰该组，app/tests 各组与生成器逐条一致。 | 登记 V01 台账既有漂移清单，随其他 BASE 漂移统一处置（重跑 writeManifest 或登记豁免理由）。 |
| F3 | Info | validator-report §3 调用点计数笔误（handoff"5 处"实为 4 处 call 表达式；computer-tools"8 处"实为 9 处）。载荷结论（调用者零改动）经独立验证为真。 | 勘误即可，不要求改流程。 |
| F4 | Info | auto-watch-screen.test.tsx 用例 "a pane the person is using is not taken over, **though the run is still tracked**" 名称后半句无对应断言（busy 恒真时 runEpoch 跟踪不可观察）。实现为真（hook 在 busy 早退前已写 `runEpoch.current`，源码 54 行），仅测试名超出断言范围。 | 可选：补一条 busy→unbusy 同 epoch 场景使名称坐实；或容忍。 |
| F5 | Obs | `$channelId.tsx` 的 `SCREEN_PANEL_WIDTH = 400` 在 BASE 与当前均为未使用常量（watch pane 用 WORKSHOP_PANEL_WIDTH=480；上游 watch 用 400）。BASE 既有死代码，非本任务引入。 | 留后续清理，勿混入本任务 diff。 |

## 7. 判定

四条 Spec §3 行为全部落实且各有测试；up05 六条中五条测试齐备，criterion 3 的路由组合层与 criterion 6 的路由 pane 关闭路径为已披露的覆盖缺口（F1，Low，不阻塞）。Ruling U01-R1 在代码、注释、测试三处一致执行，分歧留痕质量高；与上游分歧严格限定于裁决点名的路径集合语义，hook/撤回语义/合约与上游及计划逐字吻合。全部可复验声明（用例数、typecheck、format、驱动轮 6 组对账、BASE 既有红归因）经我独立复跑属实。

Spec compliance: pass
Code quality: pass
