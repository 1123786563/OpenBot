# R4-frontend 独立复审 — R4-7..R4-9

角色：independent frontend reviewer（只读）。工作区 `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`（`feat/plugin-package-market-v1`，HEAD=`9057aeeb`）。复审日 2026-10-20。

## 结论

| 维度 | 结论 |
| --- | --- |
| SPEC compliance | **PASS** |
| Code quality | **PASS** |
| Blocking findings | **0** |

## 逐项复核

### R4-7 吊销判定对齐 findSelection — 符合

- `app/src/lib/plugin-packages/use-package-scope.ts`：company 按 `tenantId` 在 `listing.data.companies` 找、team 按 `workspaceId` 在该 company 的 `teams` 找、`revoked = company === null || team === null`，与 `app/src/lib/enterprise/tenant/selection.ts` 的 `findSelection`（L190-203）逐条等价（`undefined` 检查与 `?? null` 等价；两级短路顺序一致）。
- fail-closed 方向成立：listing pending 或首次失败时 `listing.data` 为 undefined → company/team 均 null → revoked → `scope` 为 null（条件里另有显式 `listing.isPending ||`），不会以陈旧 tenant 发出目录请求；与 `selectionState` 的"pending→loading、error→error、均不发放 scope"语义同向。
- 测试真实断言零陈旧请求：`app/tests/packages-page.test.tsx` 的 harness 以 `seen` 记录全部 fetch。company 吊销（既有）与新 team 吊销两条测试都断言 `seen` 无 `/api/enterprise/plugin-packages`；pending 测试（永不 resolve 的 `scopeGate`）与失败测试同样断言零目录请求，失败测试再断言点「Try again」后货架恢复。`QueryClient` 配 `retry: false`，零请求断言不会被自动重试污染。

### R4-8 三态消费 + i18n — 符合

- 两个入口都成立：`app/src/components/market/packages-page.tsx`（成员路由 /packages）与 `app/src/routes/_authed/admin/market.tsx`（packages tab，`enabled: tab === "packages"`）均完整解构 hook 返回并透传 PackagePane。
- `app/src/components/market/package-pane.tsx` 渲染序：currentUserError → 骨架（currentUserPending **或** listingPending，同一张脸）→ listingError 失败面（`role="alert"`、错误句 + 提示句 + 复用 `packages.retry` 的重试按钮，接 `listingRefetch`→`listing.refetch()`）→ scope null 的「选择团队」空态 → PackageBrowser。加载中/失败不再误报「未选择团队」。
- i18n：`packages.scopeError` / `packages.scopeErrorHint` 在 en 与 zh-CN 均存在（market.json L58-59 两侧对称），重试复用既有 `packages.retry`。脚本化扫描两命名空间：used-but-missing 为空（`wb.grantedN` 等为 i18next 复数基准键的扫描误报），**无新增孤儿键**；`search.packages` 孤儿为 round4 计划 Parked 清单既有项，非本轮引入。
- 可选 props 兼容：新 props 全部带默认值（false/undefined）；PackagePane 直渲染消费方（grants/experts/install/catalogue 四个套件）fresh 跑全过。
- 三态测试覆盖 packages-page 入口（pending 骨架、失败文案+重试恢复、各自零目录请求）；admin 入口无专属测试，靠共享 pane 的同形 props 接线（见 Finding 2）。

### R4-9 契约唯一来源 — 符合

- `shared/enterprise/plugin-package-contracts.ts:290`：`SECRET_LOOKING_CONFIG_KEY` 已 `export`，注释按 `PACKAGE_CONFIG_LIMITS` 先例补导出理由。
- 正则本体逐字未动：与 `ocr/final-round3-attempt4.json` 引用的原文（`/(secret|token|passw|credential|api[-_]?key|private[-_]?key|authori[sz]ation|bearer|envelope|plaintext|cookie|session)/i`）完全一致。
- dialog 副本彻底移除：`app/src/components/market/package-install-dialog.tsx` 仅存 import（L37）与调用点（L143）；全仓 grep 源码目录，正则字面量只存在于契约一处（`app/dist` 为构建产物，不计）。

## 越界检查

- 本票触碰面（按实现者报告 + 现状核对）：`app/src/lib/plugin-packages/use-package-scope.ts`、`package-pane.tsx`、`packages-page.tsx`、`admin/market.tsx`、`package-install-dialog.tsx`、`shared/enterprise/plugin-package-contracts.ts`（仅一导出）、en/zh `market.json`、`app/tests/packages-page.test.tsx` — 全部在 app/ + shared 导出范围内。
- 工作树中的 `server/`、`scripts/lib/e2e-manifest.mjs`、`docs/verification/e2e-bun-suites.json` 等改动归 R4-backend 与更早 PKG 轮（backend 报告自证 server 范围；manifest 的 EXPLICIT_GROUPS 在 round4 Parked 清单中已出现，早于本轮）。**归因局限**：本 worktree 按流程无 commit，多轮改动混在同一未提交状态，无法用 git 逐 hunk 归因；但 R4-frontend 相关文件的现状逐项满足规格，未发现本票越界证据。
- 无 commit / push（HEAD 仍为 `9057aeeb`）。

## Reviewer fresh 验证（证据目录独立）

```
E2E_UNIT_OUTPUT=.e2e/r4-frontend-review-native bunx e2e run --config e2e.unit.config.ts \
  app/tests/packages-page.test.tsx app/tests/plugin-package-install.test.tsx \
  app/tests/plugin-package-catalogue.test.tsx app/tests/plugin-package-grants.test.tsx \
  app/tests/plugin-package-experts.test.tsx
 ✓ app/tests/packages-page.test.tsx (7)  ✓ plugin-package-grants (6)  ✓ plugin-package-catalogue (15)
 ✓ plugin-package-experts (7)  ✓ plugin-package-install (17)
 Test Files 5 passed (5)   Tests 52 passed (52)   EXIT=0
 report.json: run id 01a157e7-2980-7872-80b4-8885260722f7, status=passed, exitCode=0
```

```
bun run --filter app typecheck          → exit 0（0 错误）
bunx biome lint   <8 个触碰文件>         → No fixes applied
bunx biome check  <8 个触碰文件>         → No fixes applied
```

## Findings

1. **[low·非阻断] hook 级 scope 在"refetch 失败但曾有成功数据"子情形不是自身 fail-closed。** 位置 `app/src/lib/plugin-packages/use-package-scope.ts`（scope/canInstall 计算）。证据：TanStack Query v5 refetch 失败时保留上次 `data`，此时 `revoked=false`、hook 可返回非 null scope 且 `canInstall=true`；fail-closed 由 PackagePane 渲染序（listingError 面先于 Browser）保证。当前仅两个消费方且都经 PackagePane，可观察行为 fail-closed；若想与 `selectionState`（error 态不发放 scope）完全等价，可在 hook 内加 `listing.isError` 分支。建议 follow-up，不阻断。
2. **[low·非阻断] admin/market 入口的三态无专属测试。** 位置 `app/tests/packages-page.test.tsx`。三态测试只驱动成员路由；admin 入口靠共享 PackagePane + 逐行核对的同形接线保证。共享 pane 已测，风险低。
3. **[info] `listingPending = me.data != null && listing.isPending` 在 listing 被禁用（tab≠packages）时也为 true**，因禁用查询 isPending 恒真；PackagePane 仅在 packages tab 渲染，无用户可见影响。
4. **[info] 既有孤儿键 `search.packages`（en+zh）仍在**，round4 计划已 Parked（PKG06 复用或删除），非本轮引入，不扩面。
5. **[info] 归因局限**：多轮共用未提交工作树，R4/PKG 改动无法 git 逐 hunk 分离；本复审以"现状满足规格"为准，未发现本票越界。

## 与报告的差异核对

实现者报告（R4-frontend-report.md）声称的 5 项验证全部可复现（套件数/用例数 5/52 与本复审 fresh 跑一致）；偏差 1（selection.ts 实际路径）、偏差 2（dialog 格式修复纯格式零行为）、偏差 3（不加 scopeLoading 键防孤儿）均合理且与本复审证据一致。
