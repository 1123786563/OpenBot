# T01 independent review — theme token and semantic ownership

## Review binding and scope

- Reviewed `docs/plans/reports/review-packages/T01/delta.patch` only, SHA-256 `189a4b9a64aa2a50180827304c6c95b49cab108ba244e929a9cda1ecf0c5fd90`, from T01 PRE to POST. The POST checkpoint is `docs/verification/workspace-redesign/execution/checkpoints/t01/POST/checkpoint.json`, captured `2026-10-20T13:24:02.322999+00:00`, HEAD `203d0f0244b2f898218fa12027089c631e8448d9`. Its five owned-file hashes are recorded there. PRE content was used to separate pre-existing dirty state from this delta.
- Compared with the assigned Task 1 brief in `docs/plans/2026-10-20-workspace-redesign-b1.md`, `implementation-spec.md` §2, `implementation-detail.md` §2/§6, `theme-contract.json`, `CONTEXT.md`, root `AGENTS.md`, PRE `app/DESIGN.md`, and ADR 0008. The refinement documents still carry their historical “pending review” header; the execution plan identifies the user-authorized scope. This review does not reopen that decision.
- Read-only inspection; no source, requirement, issue, or test files were changed. No tests or OCR were run in this review. Verification statements below distinguish the implementation report's evidence from independently observed code.

## Spec compliance — **FAIL / incomplete**

The delta provides the contract's 58 `--ob-*` tokens in each theme, maps the listed HeroUI semantic slots in both scopes, moves legacy `--input` to `--ob-control-border`, and preserves the layered imports and existing theme preference path. The token declarations appear to match `theme-contract.json` on static inspection. The following acceptance work remains.

### S1 — Medium — reduced-motion skeleton behavior is absent

- **Evidence:** `implementation-spec.md` §2 requires `--skeleton-animation` to be `shimmer` and `none` under reduced motion; §4 also requires reduced-motion transitions at 0 ms. The added `app/src/styles/heroui-theme.css:98,189` sets `--skeleton-animation: shimmer` in both themes without a reduced-motion override. The only `prefers-reduced-motion` rule in `app/src/styles.css:296` addresses `.tool-line-running`. HeroUI's imported `skeleton.css` applies animation via `.skeleton--shimmer::after` and `::before`.
- **Impact:** A user requesting reduced motion can still see the skeleton shimmer; this breaks the explicit motion contract in both themes.
- **Smallest defensible correction:** Add a scoped reduced-motion rule in the theme layer that sets `--skeleton-animation: none` for both theme roots, and ensure the rendered skeleton's animated pseudo-elements actually stop (the imported CSS uses animation classes, so the token alone may be insufficient). Verify the computed animation for a real Skeleton at `prefers-reduced-motion: reduce`.

### S2 — Medium, acceptance blocker — required rendered theme evidence is missing

- **Evidence:** Task 1 step 3 and `implementation-detail.md` §2 require computed values for native Button/Input/Surface, wrapper values, and portal inheritance in both themes, with no unexpected fallback. `docs/plans/reports/T01-impl.md` explicitly reports that no browser was available, so all listed computed values are predictions from static mappings. Its 11 passing tests cover preference storage, not rendered CSS. `verification-plan.md` B1-A assigns the theme/portal check to T01/T02.
- **Impact:** Static equality does not establish the cascade applied to actual native elements and portals; T01 cannot yet be marked verified or treated as an accepted foundation for downstream visual work.
- **Smallest defensible correction:** Run the brief's browser/DOM matrix against this exact POST hash when a browser runtime is available, capture native and wrapper computed values and portal inheritance for both themes, and fix any observed mismatch. If the environment is unavailable, retain an explicit blocked result rather than a pass.

## Code quality — **FAIL**

The token ownership split is coherent and no obvious custom-property cycle, security exposure, concurrency change, or preference write was introduced by this delta. There is one quality gate failure and one maintenance concern.

### Q1 — Low — changed CSS fails the required formatter gate

- **Evidence:** The Task 1 brief and `verification-plan.md` require `bunx biome check` on changed source. The implementation report records full Biome exit 1 for the four changed CSS files, with formatter suggestions; only a second run with formatting disabled exited 0.
- **Impact:** The documented static check remains red and future diffs or CI checks will include avoidable formatting noise.
- **Smallest defensible correction:** Apply Biome formatting only to T01's four owned CSS files, recapture the changed checkpoint, and rerun the full scoped `biome check`. Do not count the lint-only run as satisfying the original gate.

### Q2 — Low, maintainability — duplicate full theme mapping invites drift

- **Evidence:** `app/src/styles/heroui-theme.css:11–99` and `:101–190` repeat the same 79 mappings, while their values already resolve through theme-specific `--ob-*` tokens. Any future mapping edit must be made in both blocks. The spec permits shared mappings where they consume `--ob-*` variables, as long as dark mode does not inherit light constants.
- **Impact:** A later edit can fix one theme and silently leave the other stale; it also makes ownership audits longer.
- **Smallest defensible correction:** Keep one shared selector block for mappings whose right-hand sides are theme-neutral `var(--ob-*)` references, and separate only truly theme-specific declarations. This is a non-blocking cleanup if the explicit duplication is intentionally retained with an audit guard.

## Evidence limits and verdict

- The implementation report records 11/11 targeted preference tests and a successful Vite build, but those do not exercise rendered native theme states. It also records the full Biome failure. I did not repeat tests, build, or OCR.
- **Spec compliance: fail/incomplete** due to S1 and blocked S2. **Code quality: fail** against the documented check due to Q1; Q2 is an optional low-risk cleanup. No critical/high issue was identified in the reviewed delta.
