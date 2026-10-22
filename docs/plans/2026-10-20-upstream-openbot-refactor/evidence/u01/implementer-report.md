# U01 实施报告：Computer 活动分类、撤回和屏幕 hook（A05 / Issue #494）

- 执行者：frontend_implementer。工作区：`.worktrees/upstream-openbot-update`（HEAD 3b4a7c68）。
- 未 commit/push、未用共享 stash、未派发子 Agent。改动仅限 brief owned_files。

## 1. 改动摘要

| 文件 | 改动 |
|---|---|
| `app/src/lib/copilot/computer-activity.ts` | 按 I1 合约扩展：`reportComputerActivity(botId): number`（每次调用分配独立 `announcement`，返回给调用方）；新增 `withdrawComputerActivity(botId, announcement)`、`onComputerActivityWithdrawn`；`Activity` 类型加 `announcement` 字段。保留 10 秒静默 epoch 启发式（注释明示它是静默启发式、不是服务器 runId）。 |
| `app/src/lib/computers/call.ts` | 无条件 announce 改为按 `ON_SCREEN_PATHS` 显式 allowlist announce；仅 `403`（明确拒绝，浏览器未被触碰）时以本调用拿到的 announcement 撤回；网络错误 / 500 / abort 不撤回（注释说明"未知结果 ≠ 未执行"）。`callComputer` 签名与返回 shape 不变，现有调用者（`computer-tools.tsx`、`handoff.ts`）零改动。 |
| `app/src/components/computer/use-auto-watch-screen.ts`（新建） | 上游 hook 适配本地：openedFor 只关自己打开的面板；dismissed 按 epoch；watching/busy 优先；Bot 切换/卸载清理订阅。 |
| `app/src/routes/_authed/_app/channel/$channelId.tsx` | 内联 `onComputerActivity` 订阅 + `dismissedEpoch/runEpoch` refs 替换为 `useAutoWatchScreen`；`busy = isSettingsOpen || isWorkshopOpen`；`show()` 的 dismiss 改调 `autoWatch.dismiss()`。URL pane 语义、`show()` 互斥、`DetailPanel onClose`、`ComputerChatControls` 接线全部保持。 |
| `app/tests/computer-screen-announcement.test.ts`（新建） | 14 用例：路径分类、announcement 唯一性、epoch 启发式（同 Bot 连续/换 Bot/静默超 10s）、403 撤回配对、静默路径 403 不撤回、网络/500/abort/成功不撤回、withdrawal 投递与退订。 |
| `app/tests/auto-watch-screen.test.tsx`（新建） | 16 用例：只开本 Bot、busy/watching 不抢占、同 epoch dismiss 抑制、下一 epoch 可再开、撤回配对/不配对/异 Bot 不关、person 已关不重复 close、换 Bot 后旧事件无效、卸载清理。 |
| `app/tests/computer-activity.test.ts` | 未改动（回归基线，13 用例保持全绿）。 |
| `docs/verification/e2e-bun-suites.json` | 登记 2 个新 driven suite（见 §4）。 |

## 2. 本地路径集合核对结果（以代码为准，未盲抄上游）

`grep` 全部 `callComputer` 调用点（`computer-tools.tsx`、`handoff.ts`）+ server 路由（`server/src/computer/routes.ts`）：

- **实际 announce（`ON_SCREEN_PATHS`，5 个显示动作）**：`/navigate`（handoff.ts:239）、`/click`、`/type`、`/key`、`/scroll`（computer-tools.tsx:381/339/432/842）。
- **实际存在、现不 announce**：
  - 文件/shell：`/files/list`、`/files/read`、`/files/write`（computer-tools.tsx:592/639/782）、`/exec`（:696）。
  - 非显示动作的浏览器/协调路径：`/read`、`/snapshot`（runBrowserRead，computer-tools.tsx:272/291、handoff.ts:107）、`/control/secret`（computer-tools.tsx:480）、`/control/request`（handoff.ts:213）。
  - 下载类：`/files/download` server 路由存在（routes.ts:702），但 app 无 `callComputer` 调用点（下载走 artifact/workshop 锚点）。已纳入测试清单证明其经 callComputer 时也不 announce。
- 人驱动路径（`control.ts` 的 `/human/*`、`screen.ts` 的 `/screenshot` 等）不经 `callComputer`，从不 announce（现状保持）。

## 3. RED→GREEN 证据

**RED（实现前，命令在 worktree 根执行）**
- `bun test ./app/tests/computer-screen-announcement.test.ts` → `0 pass, 1 fail, 1 error`：`SyntaxError: Export named 'onComputerActivityWithdrawn' not found`（I1 生产者缺失）。
- `bun test ./app/tests/auto-watch-screen.test.tsx` → `0 pass, 1 fail, 1 error`，exit 1：`Cannot find module '../src/components/computer/use-auto-watch-screen'`。

**GREEN（实现后）**
- `bun test ./app/tests/computer-screen-announcement.test.ts` → **14 pass / 0 fail**（31 expect）。
- `bun test ./app/tests/auto-watch-screen.test.tsx` → **16 pass / 0 fail**（23 expect）。
- 回归 `bun test ./app/tests/computer-activity.test.ts` → **13 pass / 0 fail**（未削弱）。
- 相邻 seam 回归 `bun test ./app/tests/computer-tool-refusals.test.ts` → **3 pass / 0 fail**（403/409 返回 shape 不变）。
- 驱动同款共享进程抽查（part 3 组 computer-* 5 文件一个 `bun test` 进程）：**49 pass / 0 fail**。

**统一驱动证据（V-B）**：`E2E_BUN_ONLY=app/tests bunx e2e run --config e2e.unit.config.ts tests/bun-suites.test.ts`（e2e v0.20.0，130.7s，6 组全部执行）：

| 组 | 结果 | 备注 |
|---|---|---|
| app/tests part 1（含新 `auto-watch-screen.test.tsx`） | ✓ 9.00s | 4 个既有文件仅共享进程红、独跑绿（驱动协议点名：account-mode-dialog、approvals-rules、bot-approval-rules、bot-memory），组判定通过 |
| app/tests part 2 | ✓ 14.12s | |
| app/tests part 3（含新 `computer-screen-announcement.test.ts`） | ✓ 4.03s | |
| app/tests part 4 | ✓ 34.06s | |
| app/tests/ai-observability | ✗ 67.47s | **既有红，非本任务**，见下 |
| app/tests/multitenancy | ✓ 1.62s | |

既有红对账：失败文件 `app/tests/ai-observability-route-chain.test.tsx`（独跑仍红 5/5，`queryClient.ensureQueryData` undefined）。用一次性 BASE 临时 worktree（`git worktree add` 于 HEAD 3b4a7c68，软链 node_modules，验证后已 `worktree remove` 清理）单跑同文件：同样 **0 pass / 5 fail**、`ensureQueryData` 出现 25 处——该红在 BASE 已存在，与本任务 diff 无关（该文件 import 图不含本任务任何 owned 文件）。

## 4. 清单登记与对账

- 两个新文件 import `bun-test-compat`（`bun:test` 注册表）→ 属驱动层，必须登记 `docs/verification/e2e-bun-suites.json`。
- 登记脚本先按 `scripts/lib/e2e-manifest.mjs` 的共享规则（字母序、GROUP_SIZE=24、ISLANDS、DIRECTORY_ISLANDS）**复算现有清单并验证逐组一致**（`reproduces current app/tests part groups: true`），再插入文件重算 `app/tests part N` 组；flat `files` 460→462，两文件分别落入 part 1 / part 3，级联移位已逐行 diff 核对（仅组边界移动，无文件丢失/重复，组大小 ≤24）。
- 对账：§3 的驱动轮即登记后实际执行，6 组文件数与结果如实分列，未把整组失败说成单文件结论（ai-observability 组红已单列并归因既有）。

## 5. 自查

- `bunx biome format <file>` 真实 exit code（改动文件逐一）：
  - exit 0：`computer-activity.ts`、`call.ts`、`use-auto-watch-screen.ts`、`$channelId.tsx`、`auto-watch-screen.test.tsx`（初查 exit 1 一处，为本人新增行，`--write` 修复后复查 exit 0）、`computer-screen-announcement.test.ts`。
  - exit 1：`docs/verification/e2e-bun-suites.json` —— **BASE 既有漂移**：整文件 1 空格缩进（生成器风格），BASE 版本（git show HEAD）同样 exit 1；登记行沿用文件既有缩进，未引入新偏差，未触碰漂移。
- `bun run --filter app typecheck` → exit 0（pretypecheck + tsc 均通过）。
- 窄屏/键盘关闭路径：`DetailPanel onClose → show(null)` 与 `ComputerChatControls onOpenChange → show(watch/null)` 接线逐字未动；`detail-panel.test.tsx`、`computer-control-button.test.tsx`、`live-screen-keyboard.test.tsx`、`live-screen-app-shortcuts.test.tsx` 均在 part 1–4 驱动轮内绿。channel 路由 pane 关闭本身无既有专项测试，以 diff 静态核对 + 上述套件作为证据。
- 禁止范围：未引入服务器 Run 权威、未改 gateway/权限、活动数据不持久化、未改消息存储、未改 locales。

## 6. 偏差（需要编排者/验证者注意）

1. **例外清单 → 显式 allowlist（本报告最重要偏差）**。brief 事实源与补充纪律写"OFF_SCREEN_PATHS 是例外清单不是许可清单——新浏览器路径默认继续 announce（保留上游该语义）"，但已批准 Spec §3 明文"文件、shell 和**未知请求不据猜测开屏**"、up05 AC"**未知请求不自动开屏**"、实施计划 U01 RED"按本地现有 path 建立显式 **allowlist**，未知 path 不猜测为显示动作"、A05"**只有**浏览器显示动作开屏"。四处权威一致，brief 括号注释仅复述上游 fail-open 语义。按 AGENTS.md 冲突规则（Spec > Plan/Brief/上游）实现为 `ON_SCREEN_PATHS` 许可清单，新路径默认静默，需显式加入才 announce。测试 `computer-screen-announcement.test.ts` 用 `/control/secret`、`/read`、`/snapshot`、`/hover` 钉住"未列入即静默"。
2. **行为变化（有意）**：`/read`、`/snapshot`、`/control/secret`、`/control/request` 从 announce 改为不 announce（上游与本地旧行为均 announce）。依据 A05"只有浏览器显示动作开屏"；`/control/*` 的"需要你"提示仍走既有 needs-you 通道，不依赖开屏。
3. **行为变化（有意，修旧缺陷）**：旧内联实现在 workshop 打开时收到活动会把 `watch:true` 与 `workshop:true` 同时置位、抢占面板；新实现 `busy` 含 workshop，自动开屏不再触碰用户手动打开的 Workshop/设置面板（满足 up05 AC"不关闭…设置或 Workshop 面板"）。
4. TDD 过程中测试自身脚手架有两处修正（renderAutoWatch 暴露 `result`；announcement 配对断言改为经事件 seam 观察而非手动 report 对表），均为让断言对准真实合约，未削弱断言强度。
