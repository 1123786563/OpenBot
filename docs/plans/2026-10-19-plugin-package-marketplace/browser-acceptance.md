# Browser acceptance — PKG01/PKG02 (#460/#461) · 2026-10-19 17:21 (+08)

Live stack: worktree app (vite :3320, cwd `.worktrees/plugin-package-market/app`) → proxy → worktree server (:3231) with enterprise channels on `openbot-enterprise-test-pg` (:5435). Session: real better-auth email account `pkg-acceptance@test.local` (user id `3IKTXoYd1MOC2N4ZGbJl5Jc2fq2i7gBg`), seeded as `tenant_admin` of tenant `pkg-acc-tenant` / workspace `pkg-acc-workspace` in the enterprise test DB via the setup connection (fixture arrangement, same class as MT tests).

Server-side API loop (curl, same session):
1. `POST /api/enterprise/plugin-packages/plans` → plan `004b9013-…`, exact version 1.0.0, digest `b5b2a8e1…878e`, expiresAt +10 min, no vendor calls.
2. `POST …/plans/004b9013-…/apply` (Idempotency-Key `pkg-acc-apply-1`) → **201**, install `e4b754d2-…`, revision 1, generation 1, `readiness:"needs_grant"`, blockers `[NEEDS_GRANT]`, allowedActions `[]`.
3. Replay same key → **200** same install (idempotent).
4. `GET /api/enterprise/plugin-packages` (scoped) → fixture item with `install` merged.

Browser (in-app Chromium, structural snapshot as evidence — visual surface unavailable to headless capture):
- URL `http://localhost:3320/packages` (member route, no deployment-admin gate).
- Rendered text (verbatim): 「插件包 / 浏览本团队可安装的受信插件包；安装本身不会授予 Bot 执行能力。/ 全部 · productivity / **Demo Skill** — Summarize a long note into a short, ordered brief. / openbot/demo-skill · v1.0.0 · productivity / **已安装 · r1 · 已启用 · 需要 Bot 授权** / 还没有任何 Bot 被授予该包的工具。/ 插件包已安装，但还没有任何 Bot 可以执行它：仅安装不会授予 Bot 执行权限。」
- Acceptance readout: real catalogue browse ✓ (PKG01); installed state revision 1 / generation 1 / `needs_grant` ✓ with explicit "installation grants no Bot execution" notice ✓ (PKG02); deployment-admin gate correctly redirected a `role:"user"` account away from `/admin/market` ✓.

Not exercised in-browser: preview→confirm dialog for a second install (install already existed; dialog covered by 17 component tests + the API loop above).
