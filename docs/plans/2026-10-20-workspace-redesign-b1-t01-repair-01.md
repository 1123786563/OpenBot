# B1 T01 Repair 01 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`; one specialized implementer, then validator/reviewer. No commits.

**Goal:** Correct T01 reduced-motion skeleton behavior and make its required scoped Biome formatting check green.

**Architecture:** Keep T01 token and HeroUI semantic ownership. Add the smallest reduced-motion override at the theme layer and ensure the installed HeroUI skeleton animation actually stops. Format only the T01-owned CSS files.

**Tech Stack:** Existing CSS, installed HeroUI/Tailwind/Biome. No dependency installation.

**Spec:** T01 review findings S1/Q1 in `docs/plans/reports/T01-review.md`; implementation-spec §2/§4; theme contract; original B1 plan.

## Global Constraints

- Modify only T01-owned `app/src/styles/heroui-theme.css`, `app/src/styles.css`, `app/src/styles/legacy-ui-bridge.css`, `app/src/styles/tokens.css`.
- Do not modify `app/DESIGN.md`, business components, tests, dependencies, preference storage or behavior outside motion styling.
- Preserve all pre-existing work; no commit/push/merge/deploy.
- Keep all 58 token values exact and mapping graph acyclic.
- Browser computed style remains blocked until an actual browser is available; do not claim that CSS runtime behavior passed.

## Review Focus

1. Does the installed HeroUI Skeleton stop all pseudo-element animation under `prefers-reduced-motion: reduce`?
2. Does each light/dark semantic mapping remain exact after formatting?
3. Does `bunx biome check` pass over all changed T01 source files?

## Task 1: Reduced motion and formatting

**Files:** only the four T01 CSS files listed above.  
**Consumes:** T01 POST; reviewer findings S1 and Q1.  
**Produces:** reduced motion disables skeleton shimmer and scoped Biome check passes.  
**Test:** static source inspection of installed HeroUI animation selectors; a CSS mirror test is explicitly out of scope. Browser computed style is reported blocked when runtime unavailable.

- [ ] Inspect the installed HeroUI Skeleton CSS and identify the actual animated selectors/pseudo-elements.
- [ ] Add the narrowest `prefers-reduced-motion: reduce` override in `heroui-theme.css` that disables those animations and maps `--skeleton-animation` to `none` for both root theme scopes.
- [ ] Run Biome formatting on only the four owned CSS files, then `bunx biome check` on the same files; expected exit 0.
- [ ] Re-run the static token/mapping/cycle audit; expected 58 exact values in each scope, no cycles, 79 complete semantic mappings.
- [ ] Record exact PRE/POST hashes and command exits. Do not mark rendered reduced-motion behavior passed without browser evidence.

## Ledger and review

Add T01-R1 to the B1 Ledger; bind validation and independent re-review to the resulting POST delta hash. T01 remains incomplete until the browser computed-style acceptance is either verified or reported as a genuine blocked acceptance with user-provided environment resolution.
