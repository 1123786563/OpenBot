# Task Brief R4-frontend — OCR round3 修复（前端 R4-7..R4-9）

角色：frontend_implementer。工作区：`/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`（分支 `feat/plugin-package-market-v1`，BASE `9057aeeb`）。**无 commit/push/stash 授权**；只改 `app/` 与 `shared/enterprise/plugin-package-contracts.ts` 的导出（R4-9），不改 server/、不改 docs/plans 除你的报告文件。

## 先读

1. `docs/adr/0008-test-runner-tester-army-e2e.md`（两层制；UI 组件测试走 native 层）。
2. `docs/plans/2026-10-19-plugin-package-marketplace/ocr/ocr-fix-plan-round4.md` — 你的范围 R4-7..R4-9。
3. `app/src/lib/workspace/selection.ts`（或 grep `findSelection`）L185-203 —— company+team 双层级在 listing 的判定语义（R4-7 的对齐目标）。
4. 项目技能约束：`app/src/lib/<entity>/queries.ts` / `mutations.ts` 模式（openbot-data-access）与 PageShell/Item 布局（openbot-screen-layout）——本票为既有页面补状态，不新增屏幕。

## 修复项

- **R4-7 [medium·bug]** `app/src/lib/plugin-packages/use-package-scope.ts:38-43`：吊销判定只查 company 层（`companies.find(c=>c.tenantId===stored.tenantId)`），漏 team 层。对齐 `findSelection` 语义：company 与 team 都必须仍在 listing（"a suspended team hides alone"）。补测试：team 被移出 listing 而 company 仍在 → scope 判为无效，不发陈旧请求。
- **R4-8 [medium·bug]** `app/src/components/market/packages-page.tsx:13-14`（及 `app/src/routes/_authed/admin/market.tsx` 的 `usePackageScope({enabled: tab==="packages"})`、`package-pane.tsx`）：`listingPending`/`listingError` 已由 hook 返回但无人消费——列表请求失败时 UI 误报"未选择团队"。解构并透传给 PackagePane，区分三态：加载中 / 加载失败（可重试或明示错误）/ 未选择团队。i18n en+zh-CN 补键。补测试覆盖三态渲染。
- **R4-9 [medium·maint]** `app/src/components/market/package-install-dialog.tsx:67-69`：SECRET_LOOKING_CONFIG_KEY 正则是 `shared/enterprise/plugin-package-contracts.ts:288`（未导出）的逐字复制。从契约导出（对照同文件 `PACKAGE_CONFIG_LIMITS` 的导出先例与注释理由）并改为导入；dialog 内副本删除。既有安装对话框测试应保持绿。

## 验证（fresh 跑，证据目录独立）

- native：`E2E_UNIT_OUTPUT=.e2e/r4-frontend-native bunx e2e run --config e2e.unit.config.ts app/tests/packages-page.test.tsx app/tests/plugin-package-install.test.tsx app/tests/plugin-package-catalogue.test.tsx`（按实际触碰面增减，含你新增的测试文件）。
- 门禁：`bun run --filter app typecheck`（0 错误）；触碰文件 `bunx biome lint <files>` 干净。

## 报告与边界

- 报告写 `docs/plans/2026-10-19-plugin-package-marketplace/tasks/R4-frontend-report.md`（变更、finding→修复映射、证据与输出原文、偏差）。
- 不改 server/；不改其他 docs/plans 文件；不发明产品范围；接近 turn 上限时先把已完成部分+清单写进报告。
