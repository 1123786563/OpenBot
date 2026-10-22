# Task Report R4-frontend — OCR round3 修复（前端 R4-7..R4-9）

角色：frontend_implementer。工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`（分支 `feat/plugin-package-market-v1`）。**无 commit/push/stash**——全部变更为工作树状态。

结论：**R4-7 done · R4-8 done · R4-9 done**。验证全绿（typecheck 0 错误、触碰文件 biome 干净、native e2e 5 个套件 52 条用例全过）。未改 `server/`；`shared/enterprise/plugin-package-contracts.ts` 仅新增一个导出。

## 先读记录

1. `docs/adr/0008-test-runner-tester-army-e2e.md` — 两层制；本票 UI 测试全部走 native 层（`bunx e2e run --config e2e.unit.config.ts`），证据目录用 `E2E_UNIT_OUTPUT` 指名，避免并发覆盖。
2. `docs/plans/2026-10-19-plugin-package-marketplace/ocr/ocr-fix-plan-round4.md` — 本票范围 R4-7..R4-9（均 medium），Parked low 项不扩面。
3. `findSelection` 语义 — **偏差**：简报写的 `app/src/lib/workspace/selection.ts` 不存在；实际文件为 `app/src/lib/enterprise/tenant/selection.ts`，`findSelection` 在 L190-203（L185-189 是它的判定注释）。判定语义：company 按 tenantId 在 listing 找、team 按 workspaceId 在该 company 的 teams 找，**任一缺失即 null（吊销）**；"a suspended company hides whole, a suspended team hides alone"；错误中的 listing 保持 error，不得伪装成授权事实。R4-7 以此为对齐目标。
4. 项目技能约束 — 本票未新增屏幕、未新增读取；消费既有 hook 返回值，符合 openbot-data-access（不新增 query 层）与 openbot-screen-layout（不新增布局面）。

## 变更与 finding→修复映射

### R4-7 [medium·bug] 吊销判定补 team 层 — done

- `app/src/lib/plugin-packages/use-package-scope.ts`：company 查找之后新增 team 查找（`company.teams.find(... workspaceId === stored.workspaceId)`）；`revoked = company === null || team === null`；`scope` 在 `listing.isPending || revoked` 时为 null（不发陈旧请求的既有语义扩展到 team 层）。判定注释指向 `findSelection`。
- 附带对齐（无观察行为变化，使不变量局部成立）：`canInstall` 收敛为 `!revoked && company?.role === "tenant_admin"`。scope 为 null 时没有任何 pane 渲染安装动词，故纯防御性。
- 测试（`app/tests/packages-page.test.tsx`，4→7 条）：新增 "a stored selection whose team the listing dropped falls back to select-a-team too"——company 仍在 listing、仅 team 被移出（`scopeTeams` 门控）→ 断言「Select a team first」且零条 `/api/enterprise/plugin-packages` 请求。既有 company 层吊销测试保持绿。

### R4-8 [medium·bug] 消费 listingPending/listingError，区分三态 — done

- `app/src/lib/plugin-packages/use-package-scope.ts`：返回类型新增 `listingRefetch: () => void`（`listing.refetch()` 包装），供失败面重试。
- `app/src/components/market/package-pane.tsx`：新可选 props `listingPending` / `listingError` / `listingRefetch`（带默认值，既有直渲染 PackagePane 的套件不受影响）。渲染序：accountError → 骨架（currentUser **或** listing pending，同一张脸）→ listing 失败面（`role="alert"`，错误句 + 提示句 + 重试按钮）→ scope===null 的「选择团队」空态 → PackageBrowser。加载中/失败都不会再误报「未选择团队」。文件头注释同步。
- `app/src/components/market/packages-page.tsx`：完整解构 hook 返回并透传 PackagePane。
- `app/src/routes/_authed/admin/market.tsx`：同样解构透传；原先直传的 `me.isError`/`me.isPending` 改用 hook 的 `currentUserError`/`currentUserPending`（同一查询键观察者，事实相同，单一来源）。
- i18n（en + zh-CN，插在 `packages.accountError` 之后）：
  - `packages.scopeError`："Your teams could not be loaded." /「你的团队信息加载失败。」
  - `packages.scopeErrorHint`："Plugin packages could not check which team you are in. Try again in a moment." /「插件包暂时无法确认你所在的团队，请稍后重试。」
  - 重试按钮复用既有 `packages.retry`。加载态沿用骨架网格（与 currentUserPending 现状一致），**未**新增 `scopeLoading` 键——避免制造孤儿 i18n 键（round4 Parked 清单里 `search.packages` 同类教训）。
- 测试（packages-page.test.tsx 新增 2 条 + harness 旋钮 `scopeGate`/`scopeFailure`/`scopeTeams`）：
  - "a team listing still in flight shows the skeleton, not the select-a-team state"——永不 resolve 的 listing → 骨架可见、无「Select a team first」、零条目录请求。
  - "a team listing that failed names the failure instead of claiming no team is chosen, and retry recovers"——listing 500 → 新错误文案可见、非「Select a team first」、零条目录请求；解除失败并点「Try again」→ 货架加载出卡片。

### R4-9 [medium·maint] SECRET_LOOKING_CONFIG_KEY 从契约导出 — done

- `shared/enterprise/plugin-package-contracts.ts`：`const SECRET_LOOKING_CONFIG_KEY` → `export const`，注释按 `PACKAGE_CONFIG_LIMITS` 先例补导出理由（客户端预校验与 schema 同源，防副本漂移）。正则本体逐字未动。仅此一处改动。
- `app/src/components/market/package-install-dialog.tsx`：删除本地副本 `SECRET_LOOKING_KEY` 及其注释，改为从契约导入 `SECRET_LOOKING_CONFIG_KEY`，`buildConfig` 处调用点同步改名。
- 既有安装对话框测试保持绿：plugin-package-install.test.tsx 17 条全过，含 "a secret-looking configuration key is refused before a request leaves the browser"。`grep` 确认该正则现仅存在于契约一处。

## 验证（fresh 跑，证据目录独立）

1. **native**（命令与输出原文）：

```
E2E_UNIT_OUTPUT=.e2e/r4-frontend-native bunx e2e run --config e2e.unit.config.ts \
  app/tests/packages-page.test.tsx app/tests/plugin-package-install.test.tsx app/tests/plugin-package-catalogue.test.tsx

 ✓ |node| app/tests/packages-page.test.tsx (7 tests) 188ms
 ✓ |node| app/tests/plugin-package-catalogue.test.tsx (15 tests) 635ms
 ✓ |node| app/tests/plugin-package-install.test.tsx (17 tests) 1.68s
 Test Files  3 passed (3)
      Tests  39 passed (39)
```

2. **native 扩面**（PackagePane 直渲染的另外两个消费套件，props 变更的运行时确认）：

```
E2E_UNIT_OUTPUT=.e2e/r4-frontend-native-pane-consumers bunx e2e run --config e2e.unit.config.ts \
  app/tests/plugin-package-grants.test.tsx app/tests/plugin-package-experts.test.tsx
 Test Files  2 passed (2)
      Tests  13 passed (13)
```

3. **门禁**：

```
bun run --filter app typecheck   → app typecheck: Exited with code 0（0 错误）
bunx biome lint <9 个触碰文件>    → Checked 9 files in 22ms. No fixes applied.
bunx biome check <7 个代码文件>   → Checked 7 files in 12ms. No fixes applied.
```

4. **证据落盘**：`.e2e/r4-frontend-native/report.json`（status=passed，exit=0，run id `01a157d3-851b-70fb-a772-ddc2ebeb5ccd` 为同目录最后一次写入）；`.e2e/r4-frontend-native-pane-consumers/report.json`（passed，exit=0）。

## 偏差与备注

1. **简报文件指针偏差**：`app/src/lib/workspace/selection.ts` 不存在，按 grep 结果改读 `app/src/lib/enterprise/tenant/selection.ts`（`findSelection` L190-203），判定语义与 round4 计划描述一致。
2. **格式修复越出本次 finding 的字面行**：`package-install-dialog.tsx` 里两处 `setPlanError`/`setApplyError` 的多行包装是触碰面上既有的格式漂移（未提交功能代码，非本次修复引入），`biome check` 对其报 format 错误。已对该单文件执行 `bunx biome check --write`（纯格式、零行为差异），使触碰文件 `biome check` 干净；`biome lint` 本就已干净。
3. **三态的「加载中」脸无独立文案**：沿用骨架网格（与 currentUserPending 现状一致），不加 `scopeLoading` 键，理由见上（孤儿键纪律）；「失败」脸按要求补了 en+zh-CN 两键并带重试（"可重试或明示错误"两者都做了）。
4. **验证扩面**：简报列 3 个套件，按"按实际触碰面增减"加跑了 grants/experts 两套（PackagePane 直渲染消费方）；catalogue 套件已含在简报清单内。
5. **既有工作树状态**：本 worktree 含 PKG01/02 未提交功能改动（含他人并行的 server/ 改动，本票未触碰）；本报告全部验证是在该状态之上的 fresh 跑。
6. Parked low（role 字面量比较无编译期保护等）按 round4 裁决未扩面。

## 边界确认

- 未改 `server/`（`git status` 中 server/ 改动均为进入本票前已存在的并行工作）。
- `docs/plans/` 仅新增本报告文件。
- 无 commit / push / stash。
