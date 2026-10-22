# T01 final independent review — theme token and semantic ownership

## Scope and evidence

- Reviewed the complete PRE→POST-R1 `docs/plans/reports/review-packages/T01/delta-final.patch`, SHA-256 `74238dd85492a58750a353e034feefc22b6958daa56ce6688338beaf2def4100`. The five current owned-file hashes match `POST-R1/checkpoint.json`; this review is bound to that package, not the superseded initial POST.
- Compared the delta with the assigned T01 and T01-R1 briefs, `implementation-spec.md` §2 and §4, `implementation-detail.md` §2 and §6, `theme-contract.json`, `CONTEXT.md`, ADR 0008, and the previous T01 review. The refinement files retain their historical pending header; the execution plan records the authorized T01 scope.
- This was a read-only source review. No tests, build, browser run, or OCR were invoked here. Test results below are identified as implementation-report evidence.

## Findings

### F1 — Medium — reduced-motion theme override escapes the required layer

- **Evidence / affected symbol:** `app/src/styles/heroui-theme.css:249–261` places the new `@media (prefers-reduced-motion: reduce)` block outside `@layer ob-theme`. That block declares the HeroUI theme variable `--skeleton-animation` and an animation override. `implementation-spec.md` §2 requires the existing layer order and explicitly prohibits unlayered theme declarations; `app/src/styles.css:15–22` documents that unlayered declarations outrank all named layers.
- **Impact:** The actual shimmer is suppressed under reduced motion, but the repair breaks the specified single theme owner and gives these declarations permanent precedence over future layered theme or component rules. The explicit layering acceptance is unmet.
- **Smallest defensible correction:** Move the media block inside `@layer ob-theme`, after the light and dark mappings. That layer follows HeroUI's `components` layer, so the pseudo-element `animation: none` can still win without an unlayered rule. Recheck the compiled CSS and real computed animation when browser verification is available.

### S2 — Medium, acceptance blocker — rendered theme evidence remains unavailable

- **Evidence / affected acceptance:** T01 step 3 and `implementation-detail.md` §2 require computed values from native Button/Input/Surface, wrappers, and portals in both themes. `T01-impl.md` records `browser-use` exit 127, an empty CUA browser inventory, and an unavailable IAB browser. `T01-R1-impl.md` reports the browser check still blocked. Its token and CSS audits cannot establish actual applied cascade, portal inheritance, or reduced-motion animation.
- **Impact:** The foundation's rendered acceptance cannot be signed off or marked verified for this POST hash. This is an evidence gap, not a claim that those rendered states fail.
- **Smallest defensible correction:** When a browser runtime is available, capture the brief's light/dark native, wrapper, portal, and reduced-motion computed-style matrix against the same source checkpoint, then correct any observed mismatch. Until then retain `blocked`.

## Prior findings and other review observations

- **S1, source behavior: resolved on static inspection.** `heroui-theme.css:249–260` sets `--skeleton-animation: none` and stops both shimmer pseudo-elements under reduced motion. The installed HeroUI skeleton CSS uses `::after` for an individual shimmer and `::before` for a synchronized parent shimmer. The app's Skeleton wrapper also has `motion-reduce:animate-none` for its own pulse class. F1 records the remaining layer violation. Browser confirmation of computed behavior remains part of S2.
- **Q1: resolved by reported gate evidence.** `T01-R1-impl.md` records `bunx biome check` exit 0 on all four owned CSS files after scoped formatting. This review did not rerun that command.
- **Q2: low, still open as maintenance advice.** `heroui-theme.css:11–126` and `:129–245` duplicate the same theme-neutral semantic mappings. The present mappings match on inspection, but future edits can drift. A shared mapping selector for `var(--ob-*)` declarations would reduce that risk; this need not block this task.
- The 58 light and 58 dark `--ob-*` declarations, 79 native mappings in each theme, legacy `--input` to `--ob-control-border`, and absence of a new preference write agree with the contract on static inspection. No security, concurrency, or data consistency change was found in this five-file CSS/documentation delta.

## Verdict

- **Spec compliance: FAIL / incomplete.** F1 violates the explicit layering rule. S2 remains blocked until browser evidence is collected. S1's source repair is present.
- **Code quality: FAIL on architecture until F1 is corrected.** The previous formatter failure is resolved per the repair report; Q2 remains optional. No critical or high issue was found.
