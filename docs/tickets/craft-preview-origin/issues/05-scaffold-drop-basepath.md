## Parent

- GitHub Issue: #364（已发布，标签 ready-for-agent）
- Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`
- 覆盖验收标准：AC2
- 主战场：`openbot`

## What to build
脚手架退场 basePath。应用在 preview origin 的根路径上服务，`next.config.ts` 的 `resolveWebappBasePath()`（cwd 正则抠 session id）、`assetPrefix`、`redirects` 的 `/` 兜底全部删除；`lib/base-path.ts` 保留导出但 `BASE_PATH` 恒为空串（不破坏第一步已生成的应用）。`AGENTS.md` 的 API 指导同步改写为"应用在根路径，直接用绝对路径"。

## Acceptance criteria
- [ ] 新脚手架的 `next.config.ts` 不再含 basePath/assetPrefix/redirects/resolveWebappBasePath
- [ ] `lib/base-path.ts` 仍导出 `apiUrl` 且返回值与传入路径一致（不产生 "undefined/…"）
- [ ] `AGENTS.md` 无 basePath 相关足枪描述，API 指导与实际行为一致
- [ ] 预览内资源 URL 全部落在 preview origin 根下（无 `/api/craft/sessions/<id>/webapp/_next/...`）
- [ ] 既有 `craft-webapp-template.test.ts` 更新为新契约（不留过时断言）

## Contracts
**Consumes**：03（host 路由后路径不再承载会话语义）
**Produces**：根路径脚手架契约；`craft-webapp-template.test.ts` 的新断言集

## Implementation steps
1. 删 next.config.ts 三段 + resolveWebappBasePath，保留 allowedDevOrigins
2. base-path.ts 置空串并更新注释（保留导出）
3. AGENTS.md 重写 API/URL 指导
4. 更新 craft-webapp-template.test.ts 断言；真实浏览器回归资源 URL 与交互

## Write scope
`server/assets/craft/web-template/`（next.config.ts、lib/base-path.ts、AGENTS.md）、`server/tests/craft-webapp-template.test.ts`。
