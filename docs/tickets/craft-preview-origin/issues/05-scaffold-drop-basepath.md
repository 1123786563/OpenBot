## Parent

- GitHub Issue: #364（已发布，标签 ready-for-agent）
- Spec：`docs/specs/2026-10-15-craft-preview-origin-design.md`
- 覆盖验收标准：AC2
- 主战场：`openbot`

## What to build
脚手架退场 basePath（R-6 口径）。应用在生产 host 形态的 preview origin **根路径**上服务；dev 形态由显式环境变量挂载：`next.config.ts` 读 `ONYX_WEBAPP_BASE_PATH`（trim 非空且通过白名单 `^\/[0-9a-z-]{1,64}$` 才设 `basePath`/`assetPrefix`，空/未设即根路径），并把同一值镜像进 `env.NEXT_PUBLIC_BASE_PATH`；`lib/base-path.ts` 读 `NEXT_PUBLIC_BASE_PATH`（同一白名单，非恒空串）。**cwd 正则推导（`resolveWebappBasePath`）与 `redirects` 的 `/` 兜底维持退场**——env 由受控启动方（服务端生成的 start 脚本）注入，非进程位置猜测。`AGENTS.md` 的 API 指导同步改写为双形态口径：「生产 host 形态在根路径，直接用根绝对路径；dev 形态自动挂载 `/<label>`（env 注入），勿手改 basePath」。

> **修订 2026-10-17（codex 重审 F-2）**：原验收（「`next.config.ts` 不再含 basePath/assetPrefix、`lib/base-path.ts` 常量空串、`AGENTS.md` 指导根路径裸绝对 URL」）与 Spec R-6（2026-10-16 批准）冲突，按「Spec > 票面」优先级修订为：**生产路径为根（无 basePath）；dev 形态经显式环境变量挂载 basePath（`ONYX_WEBAPP_BASE_PATH` 白名单），禁止 cwd/隐式推导**。裁决记录：Spec《craft-preview-origin design》R-6 修订注（final-review F-2）与执行 Ledger §11 R-6；实现与测试见 #365 F-2 修复。原验收第 1/3/4 条逐字要求随之作废，第 2/5 条按 R-6 口径改写保留于下。

## Acceptance criteria
- [ ] 生产 host 形态（env 未设/为空）：新脚手架的 `next.config.ts` 不设 basePath/assetPrefix，应用在 origin 根路径服务
- [ ] dev 形态：服务端生成的 start 脚本注入 `ONYX_WEBAPP_BASE_PATH=/<label>`（白名单 `^\/[0-9a-z-]{1,64}$`），`next.config.ts` 据此挂载 basePath/assetPrefix，资源 URL 全部落于 `/<label>` 段下
- [ ] cwd/隐式推导退场不回潮：无 `resolveWebappBasePath`（cwd 正则抠 session id）、无 `redirects` 的 `/` 兜底；env 仅由受控启动方注入
- [ ] `lib/base-path.ts` 仍导出 `apiUrl`：根形态下返回值与传入路径一致（不产生 "undefined/…"）；dev 形态按 `NEXT_PUBLIC_BASE_PATH`（同一白名单）携带前缀
- [ ] `AGENTS.md` API 指导与实际行为一致：双形态口径（根路径绝对 URL / dev 形态 env 注入前缀），无 basePath 足枪描述
- [ ] 预览内资源 URL 全部落在 preview origin 的对应挂载下（dev 形态带 `/<label>`、host 形态在根，无 `/api/craft/sessions/<id>/webapp/_next/...`）
- [ ] 既有 `craft-webapp-template.test.ts` 更新为新契约（不留过时断言）

## Contracts
**Consumes**：03（host 路由后路径不再承载会话语义）
**Produces**：根路径脚手架契约；`craft-webapp-template.test.ts` 的新断言集

## Implementation steps
1. 删 `resolveWebappBasePath` 与 `redirects` 的 `/` 兜底，保留 `allowedDevOrigins`；basePath/assetPrefix 采用 R-6 的 env 驱动形态（白名单 trim 非空才设）
2. `base-path.ts` 读 `NEXT_PUBLIC_BASE_PATH`（与 `next.config.ts` 同一白名单）并更新注释（保留导出）
3. `AGENTS.md` 重写 API/URL 指导（双形态口径）
4. 更新 `craft-webapp-template.test.ts` 断言；真实浏览器回归资源 URL 与交互

## Write scope
`server/assets/craft/web-template/`（next.config.ts、lib/base-path.ts、AGENTS.md）、`server/tests/craft-webapp-template.test.ts`。
