# T01 independent final review — R2

## Scope and evidence

- Reviewed the complete T01 PRE→POST-R2 package in `docs/plans/reports/review-packages/T01/delta-final-r2.patch`, SHA-256 `221d9c2918194b1862a05fbc86584cd17dd776c11cc5adac6bb665ed8fb845e7`. The current five owned source files match the hashes in `POST-R2/checkpoint.json`. The patch contains only `app/DESIGN.md` and the four assigned CSS files; unrelated shared-worktree changes were excluded.
- Compared the package with the T01 and T01-R2 briefs, the authorized B1 plan, `implementation-spec.md` §2, `implementation-detail.md` §2, `theme-contract.json`, `CONTEXT.md`, ADR 0008, and the two preceding T01 reviews. The refinement documents still have historical pending headers; the B1 execution plan records the authorized implementation scope.
- This is static source review. I did not run tests, a browser, or OCR. Command results cited below come from the implementation reports.

## Remaining finding

### S2 — Medium, acceptance blocker — rendered theme evidence remains unavailable

- **Evidence / affected acceptance:** T01 step 3 and `implementation-detail.md` §2 require real computed styles for native Button/Input/Surface, wrappers, and portals in both themes. `T01-impl.md` records `browser-use` exit 127, an empty CUA browser inventory, and unavailable IAB. Neither R1 nor R2 provides a browser matrix. Static token audits, preference tests, and the build cannot establish the applied cascade, portal inheritance, or actual reduced-motion animation.
- **Impact:** The source implementation is reviewable, but T01's rendered acceptance and downstream `verified` gate cannot be signed off for this checkpoint. This is an evidence blocker, not an observed visual failure.
- **Smallest defensible correction:** With a browser runtime, capture the brief's light/dark native, wrapper, portal, and reduced-motion computed-style matrix against the same source hash; correct any observed mismatch and recapture/review changed files. Keep the gate `blocked` meanwhile.

## Prior findings

- **S1 — source repair resolved, rendered behavior blocked under S2.** `app/src/styles/heroui-theme.css:248–260` sets `--skeleton-animation: none` under reduced motion and disables both `::before` and `::after` shimmer animation. The installed HeroUI skeleton stylesheet applies shimmer to those two pseudo-elements. The override is in `ob-theme`, a layer after the imported `components` layer. Actual computed animation remains unverified.
- **Q1 — resolved by reported check evidence.** `T01-R1-impl.md` records exit 0 for full scoped `bunx biome check` across the four owned CSS files; `T01-R2-impl.md` records exit 0 for the subsequently changed `heroui-theme.css`. I did not rerun those commands.
- **F1 — resolved on static inspection.** The media block is now nested inside `@layer ob-theme` at `heroui-theme.css:10–261`, after both theme mappings. `app/src/styles.css:15–22` places that layer after HeroUI `components`. The combined delta has no new unlayered theme declaration.
- **Q2 — Low, existing maintenance advice.** `heroui-theme.css:11–126` and `:129–245` duplicate the same theme-neutral semantic mappings. They agree now; future edits can drift. A shared selector for mappings that consume `var(--ob-*)` would reduce that risk. This is optional cleanup, not a T01 acceptance blocker.

## Verdict

- **Spec compliance: BLOCKED on S2.** Static ownership and mapping meet the assigned T01 contract on inspection: 58 light and 58 dark `--ob-*` tokens, 79 native mappings per theme, legacy `--input` mapped to control border, and the reduced-motion rule in the required layer. Required rendered values and portal behavior have no browser evidence.
- **Code quality: PASS for this reviewed source delta, with Q2 low advice.** The scoped formatter gate is reported green, and no additional correctness, security, concurrency, data consistency, or architecture issue was identified in these five files. This is not a claim that the browser acceptance passed.
