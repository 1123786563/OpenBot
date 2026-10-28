# FIX-1d：F-A8 realtime-usage-ui fixture 补 account — 修复报告

- 日期：2026-10-26
- 工作区/分支：`1123786563/b5r-fix1`（worktree `b5r-fix1`）
- 基线 HEAD：79b189119（FIX-1c 收口后）
- 改动范围：仅 `app/tests/realtime-usage-ui.test.tsx`（测试 fixture + 新增 1 用例），产品组件零改动

## 根因确认（修复前实跑复现）

`bun test app/tests/realtime-usage-ui.test.tsx --timeout=120000` → **0 pass / 3 fail**，每条用例同一形态：

```
TypeError: undefined is not an object (evaluating 'balance.account.status')
    at PersonalBalanceCard (app/src/components/billing/personal-balance-card.tsx:54:18)
```

- BP07（#375，2026-10-23）把 `account: { status: "active"|"quarantined"; quarantineReason: string|null }` 设为线上契约必填（server 契约 `server/src/billing/types.ts` `PersonalCreditBalance.account`；客户端镜像 `app/src/lib/billing/credits.ts:80` 同型），`PersonalBalanceCard` 第 54 行直接读 `balance.account.status` 渲染隔离徽标。
- 本套件 fixture `BALANCE` 无 `account` 键 → 卡片渲染即抛 TypeError，3 条用例全败。全文件历史（e8ea2102a 创建后 `git diff` 为空）从未含 `account`/`quarantin`/`capability` 字样——**并非断言被删**，是套件先于 BP07 契约扩张、未随迁；31afb89fa/main 同败（C1 app 扫描未覆盖），与任务描述一致。

## 代码改动

1. **fixture 补 `account`**（默认 active）：`BALANCE` 增 `account: { status: "active", quarantineReason: null }`，与姊妹套件 `personal-credits-ui.test.tsx` 的 fixture 形状一致。3 条既有用例断言原文零改动——其原意（消费/待结算/异常原因渲染、空载荷空句、实时面不可用整节隐藏）本就完整，此前仅被 TypeError 阻断。
2. **`installFetchStub` 增可选第二参 `balance = BALANCE`**，summary 路径改答注入值，供第 4 用例覆写。
3. **新增第 4 用例**（任务可选项，低成本）：「隔离账户的能力徽标是固定句，原始隔离原因不进 DOM」——quarantined + 原始 reason `"legacy key with unknown attribution"`，断言 `account-capability` 徽标含固定句「能力暂不可用」（词典键 `creditsPage.capabilityUnavailable`，zh-CN settings.json:326）且原始 reason 不进 `document.body.textContent`。走整页 `renderView()` 的 summary 读路径，与姊妹套件在组件面直测互补。

## 验收读数（仓库根执行）

| 验证 | 读数 |
| --- | --- |
| `bun test app/tests/realtime-usage-ui.test.tsx --timeout=120000` | **4 pass / 0 fail / 13 expect()**（修复后两轮复跑同数，396ms 级） |
| `bunx biome check app/tests/realtime-usage-ui.test.tsx` | 与 HEAD 基线 findings 完全相同（format 整文件漂移 + import 排序，均系存量；新增行零新 finding，biome 格式化输出不触及新增块） |
| `cd app && bunx tsc --noEmit` | 65 errors = 已知基线（2026-10-25 巡检 62→65），本文件零错误 |
| 产品组件改动 | 无（`git diff --stat` 仅 1 test 文件，+40/−2） |

## 结论

F-A8 收敛：套件由 0/3 全红翻至 4/4 全绿（3 修复 + 1 语义增强），BP07 徽标语义（固定句、原始 reason 不外泄）在本套件经整页路径钉住。无遗留；提交 `fix(FIX-B5-A8)`，本地提交未推送。
