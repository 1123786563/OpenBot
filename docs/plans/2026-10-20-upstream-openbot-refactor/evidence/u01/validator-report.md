# U01 Validator Report：Computer 活动分类、撤回和屏幕 hook（A05 / Issue #494）

- 验证者：frontend_validator（只读验证；未修改任何业务/测试源码、未 commit/stash/push、未派发子 Agent）。
- 工作区：`.worktrees/upstream-openbot-update`（HEAD 3b4a7c68）。验证时间：2026-10-20。
- 结论：**PASS（5/5 项全部通过）**。问题仅 4 条 Info 级备注，无 Low/Medium/High/Critical。

## 1. 行为验证 — PASS

亲跑三个 suite（`bun test`，worktree 根执行）：

| Suite | 结果 | 与报告口径 |
|---|---|---|
| `bun test ./app/tests/computer-screen-announcement.test.ts` | **14 pass / 0 fail**（31 expect），exit 0 | 与 implementer-report §3 一致 |
| `bun test ./app/tests/auto-watch-screen.test.tsx` | **16 pass / 0 fail**（23 expect），exit 0 | 一致 |
| `bun test ./app/tests/computer-activity.test.ts`（回归） | **13 pass / 0 fail**（15 expect），exit 0 | 一致，未削弱 |

相邻 seam 抽查：`bun test ./app/tests/computer-tool-refusals.test.ts` → 3 pass / 0 fail（403/409 返回 shape 未变）。

断言抽查（逐条读测试源码核实，全部真实钉住，非空转断言）：

- **不产生 announcement**：`/files/list`、`/files/read`、`/files/write`、`/files/download`、`/exec`（announcement.test 第 1 用例）；`/control/secret`、`/read`、`/snapshot`、`/hover`（未知路径代表，第 2 用例）。断言 `activities` 全空。
- **产生 announcement**：`/navigate`、`/click`、`/type`、`/key`、`/scroll` 全部产生且逐次独立（第 3、4 用例：botId 序列逐一对应、announcement id 两两不同）。
- **epoch 启发式**：同 Bot 快速连续同 epoch、换 Bot 新 epoch、静默 >10s 新 epoch（mock `Date.now`），3 用例齐备。
- **403 只撤回同 announcement**：`withdrawals` 精确等于 `[{botId, announcement: 本次活动的 announcement}]`，且静默路径的 403 产生零 withdrawal（第 2 用例组）。
- **网络错误 / 500 / abort 不撤回**：三个用例各自断言 announcement 已发生、withdrawals 为空；abort 另断言 `stopped: true`；成功也保留（不撤回）。

## 2. hook 语义 — PASS

`app/src/components/computer/use-auto-watch-screen.ts` 与上游 `evidence/upstream-sources/` 版本逐行比对：逻辑一致（仅重命名 `run`→`runEpoch`、`dismissed`→`dismissedEpoch`，doc comment 增补 workshop），本地适配点正确。语义逐项核对（hook 测试 + 路由接线双重证据）：

- **手动面板不被抢占**：hook 内 `if (isWatching || isBusy) return;`；路由传 `busy: isSettingsOpen || isWorkshopOpen`（`$channelId.tsx:71`）。测试 `a pane the person is using is not taken over, though the run is still tracked` 钉住"busy 时 run 仍被跟踪"。
- **watching 不重复开**：两条用例（初始 watching；活动后 update watching=true 再来活动均不二次 open）。
- **dismiss 后同 epoch 不重开、下一 epoch 可再开**：`dismissedEpoch === activity.epoch` 早退；`Date.now` mock +11s 证明下一 run 可 open（第 2 次）。
- **换 Bot / 卸载清理**：useEffect cleanup 停双订阅、`[botId]` 重挂；4 条测试覆盖旧 Bot 迟到 announcement/withdrawal 均无效、新 Bot 正常开、卸载后双通道均静默。
- **openedFor 不匹配的 withdrawal 不关面板**：`openedFor.current !== withdrawal.announcement` 早退；用例覆盖异 announcement、异 Bot、dismiss 后迟到 withdrawal 三种不关。

## 3. 接口与路由 — PASS

- **I1 合约逐一核对**（`app/src/lib/copilot/computer-activity.ts`）：`Activity = {botId, epoch, announcement}`、`Withdrawal = {botId, announcement}` 两类型 export；`reportComputerActivity(botId): number`、`withdrawComputerActivity(botId, announcement): void`、`onComputerActivity(listener): () => void`、`onComputerActivityWithdrawn(listener): () => void` 签名与 implementation-plan §2 I1 逐字一致。10 秒静默启发式保留，模块头注释明示"not a server run id"。
- **callComputer 兼容**：签名 `(botId, path, init?, signal?) => Promise<ToolOutcome>` 与返回 shape（ok/reason/refused/rule/staleRefs/humanHasControl/handoff）不变。grep 全部调用点仅 `computers/handoff.ts`（5 处）与 `copilot/computer-tools.tsx`（8 处 + re-export），`git diff HEAD --` 两文件均为空——现有调用者零改动，实锤。
- **本地路径集合核对**（对照 `server/src/computer/routes.ts` 与两个调用点）：经 `callComputer` 的实际路径全集 = `/snapshot`、`/control/request`、`/navigate`（handoff）+ `/type`、`/click`、`/key`、`/control/secret`、`/files/list`、`/files/read`、`/exec`、`/files/write`、`/scroll`（computer-tools）。`ON_SCREEN_PATHS`（5 个显示动作）与之吻合，无遗漏的真实显示路径；`/files/download` server 路由存在（routes.ts:702）但 app 无调用点，测试仍钉住其经 callComputer 时静默。人驱动路径不经 callComputer，现状保持。
- **channel 路由接线**：`busy: isSettingsOpen || isWorkshopOpen` 正确（上游无 workshop，本地扩展是真实适配而非漏改）；`open()` 置 `watch:true` 并清 `settings`/`workshop`（共享 pane 互斥语义保持）；`close()` 仅清 `watch`；`show()` 的 `if (next !== "watch" && isWatching) autoWatch.dismiss()` 即"关 watch 时 dismiss 生效"，`DetailPanel onClose → show(null)` 与 `ComputerChatControls onOpenChange` 接线逐字未动。

## 4. 范围与清单 — PASS

- **改动仅 owned_files**：`git status` app/ 段 = 3 个 tracked 修改（call.ts、computer-activity.ts、$channelId.tsx）+ 3 个 untracked 新文件（use-auto-watch-screen.ts、两个新测试）；docs/ 段 = e2e-bun-suites.json。恰好 4 tracked + 3 new，无超界文件。`app/tests/computer-activity.test.ts` 对 HEAD 零 diff（仅可扩展不可削弱——未动即零削弱），既有 13 用例全绿。
- **登记与对账**：两新文件均 import `bun-test-compat`（属驱动层须登记）。我按 `scripts/lib/e2e-manifest.mjs` 规则（字母序、GROUP_SIZE=24、ISLANDS、DIRECTORY_ISLANDS）独立复算：flat 462 条全排序、组/flat 双向包含一致；`app/tests part 1`（24 文件，含 auto-watch-screen）、part 2（24）、part 3（24，含 computer-screen-announcement 与 computer-activity）、part 4（6）、`app/tests/ai-observability`（10）、`app/tests/multitenancy`（1）与登记文件逐一相符。`server/tests/multitenancy` 26+25 的非 24 切分经与 `git show HEAD` 对照为 BASE 既有状态，非本任务引入。
- **统一驱动亲跑**：`E2E_BUN_ONLY=app/tests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`（e2e 0.20.0，138.8s）：6 组全部执行，summary `selected 6 / executed 6 / passed 5 / failed 1`。part 1 ✓（11.3s）、part 2 ✓（15.0s）、part 3 ✓（2.5s）、part 4 ✓（34.7s）、multitenancy ✓（1.1s）；ai-observability ✗——失败文件 `ai-observability-route-chain.test.tsx` 5/5 独跑仍红（`queryClient.ensureQueryData` undefined），即 ledger §7 已登记的 BASE 既有红，按本次验收口径不计入回归。part 1 驱动器点名的 4 个"仅共享进程红、独跑绿"文件（account-mode-dialog、approvals-rules、bot-approval-rules、bot-memory）符合 ADR 0008 补充二协议，组判定通过。实现者报告的分组结论与我的执行逐组一致，无把整组失败说成单文件结论的情形。

## 5. typecheck / format — PASS

- `bun run --filter app typecheck` → exit 0（pretypecheck + tsc 均过）。
- `bunx biome format` 逐一：6 个改动文件（call.ts、computer-activity.ts、use-auto-watch-screen.ts、$channelId.tsx、auto-watch-screen.test.tsx、computer-screen-announcement.test.ts）全部 exit 0。`e2e-bun-suites.json` exit 1，但 BASE 版本同样 exit 1（既有生成器风格漂移），且把 BASE 与当前文件各自过 format 后 diff，差异恰好只有两条新登记及随之的组边界移动——登记行未引入新偏差。

## 6. Ruling U01-R1 执行质量 — PASS

裁决链核实：brief"例外清单"句与已批准 Spec §3（"文件、shell 和未知请求不据猜测开屏"）、up05 AC（"未知请求不自动开屏"）、A05（"只有浏览器显示动作开屏"）、计划 U01 RED（"显式 allowlist"）冲突，ledger §7（2026-10-20）主控确认按 Spec 实现显式 `ON_SCREEN_PATHS` allowlist。执行质量：

- 代码与裁决完全一致：5 路径 allowlist，未知路径默认静默；`call.ts` 注释明确写成 "A PERMIT LIST, and deliberately so"，并说明与上游 fail-open 语义分歧的后果权衡（漏登记的代价是"该开不开"而非"无中生有的 pane"），分歧留痕充分。
- 连带行为变化（/read、/snapshot、/control/* 不再 announce；workshop 不再被抢占）与裁决记录一致，且各有测试钉住（/control/secret、/read、/snapshot、/hover 静默；busy 含 workshop）。
- 与上游的分歧范围有界：hook 逐行同上游、403 撤回语义逐字同上游、I1 合约同计划——分歧只发生在裁决点名的路径集合语义上。

## 7. 问题分级

| 级别 | 描述 |
|---|---|
| Info-1 | hook 的 `runEpoch`/`dismissedEpoch`/`openedFor` refs 在 Bot 切换时不显式清零（与上游逐字一致）。检查可达性：announcement id 全局单调且 per-report 唯一，`openedFor` 只可能是当前订阅 Bot 的活动，withdrawal 又按 botId 过滤，跨 Bot 撞号不可达；I1"重置引用"在可观察行为层面（订阅重建、openedFor 随 close/dismiss 生命周期）已满足。无需行动。 |
| Info-2 | 路由 `open()` 比上游多清 `workshop` flag：本地真实适配（上游无 workshop pane），属报告偏差 3 的正向组成，非缺陷。 |
| Info-3 | `e2e-bun-suites.json` format 漂移为 BASE 既有（双方 exit 1），登记行沿用文件既有风格，无新增违规；V01 全量 format:check 时按台账既有口径统一处理。 |
| Info-4 | RED 阶段证据（缺 `onComputerActivityWithdrawn` 导出、缺 hook 模块的两条 fail）与我读到的最终代码依赖关系吻合，逻辑上必然先红；因验证只读、不可回滚复跑，采信报告记录（证据为文本留档）。ai-observability BASE 红的归因采信 ledger §7 台账 + 本次任务指令（已登记既有红），未另起 worktree 复证。 |

## 8. 验收结论

**Task U01 验收 PASS。** 三 suite 亲跑 14/16/13 全绿、统一驱动 6 组对账吻合（唯一红为已登记 BASE 既有红）、I1 合约与 callComputer 兼容零改动实证、改动严格限于 owned_files、typecheck/format 干净、Spec-over-brief 裁决（U01-R1）执行到位且分歧留痕完整。4 条 Info 备注均无需在本任务内行动。
