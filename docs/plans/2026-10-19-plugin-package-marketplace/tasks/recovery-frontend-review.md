# Recovery frontend review: cp01-recovery

Role: independent reviewer; no source edits, no agents, no Git writes. Write only `docs/plans/2026-10-19-plugin-package-marketplace/review-frontend-cp01.md`.

Workspace `/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market`; checkpoint `checkpoints/cp01-recovery/manifest.json`, SHA f778141a7954cd4683179e31593cc3e3f029cf20b833a8da3c3c7d044d77e43a, HEAD 9057aeeb.

Read approved spec §7/11/14 and PKG01/02 issue bodies, AGENTS.md, ADR 0008. Earlier briefs do not authorize deviations. Prior PKG01 verified label withdrawn: no browser/real-auth evidence and no content-bound old snapshot.

Review complete package UI/query/mutation/client files + tests and real route ancestry/navigation: `app/src/routes/_authed/admin/route.tsx` lines 10-18 requires deployment `role=admin`, whereas MarketPage now uses company tenant_admin only for its button. Determine whether ordinary team members and non-deployment company admins can actually reach the market through the real router. A test rendering exported MarketPage bypasses beforeLoad and cannot prove that. Also verify selected principal identity, workspace selection source, scope switch during plan/apply, cancelled request and idempotency retry/unknown install-result behavior; contract changes in client do not affect other callers; mutated keys cannot overwrite scoped content. Examine entire read/mutation path rather than only named helpers.

Reassess prior pending-plan deadlock, wrong role source, limit in cache key, config editable during apply, weak late-response invalidation test, 403/409 recovery/new-key tests. Report real remaining behavior issues, not status from prior reviewer. All valid critical/high/medium block verified. No actual browser evidence exists yet; do not call browser acceptance PASS based on component tests.

Run frontend tests only if useful with a UNIQUE report dir `.e2e/cp01-frontend-review` (never reuse old dirs), plus app typecheck as needed; no live shared services. Report Spec compliance and code quality separately, each finding with ID/severity/file:line/minimal fix. Include test counts from current report and explicit browser evidence gap. <=1000 words. Verify checkpoint before and after using `python3 docs/plans/2026-10-19-plugin-package-marketplace/checkpoint.py cp01-recovery --verify`.
