# B1 T01 Repair 02 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`; one specialized implementer, then read-only validator/reviewer. No commits.

**Goal:** Move the reduced-motion HeroUI theme override into the required `ob-theme` layer without changing its visual result.

**Architecture:** Preserve the existing light/dark token ownership and animation override; change only its CSS cascade layer location.

**Tech Stack:** Existing CSS/Biome. No dependency installation.

**Spec:** `docs/plans/reports/T01-final-review.md` finding F1; `implementation-spec.md` §2; main B1 plan.

## Global Constraints

- Only modify `app/src/styles/heroui-theme.css`.
- Preserve the explicit override for both HeroUI skeleton shimmer pseudo-elements and `--skeleton-animation: none` under reduced motion.
- Keep declarations layered in `ob-theme`, which follows HeroUI `components`; add no unlayered theme declarations.
- Preserve all other edits; no tests, product dependency installs, or commits.

## Review Focus

1. `@media (prefers-reduced-motion: reduce)` is nested in `@layer ob-theme`.
2. Both skeleton pseudo-element selectors and the token retain `animation: none`.
3. Full T01 Browser computed-style remains an external acceptance blocker until runtime is available.

## Task 1: Place the override in the theme layer

**File:** `app/src/styles/heroui-theme.css` only.  
**Consumes:** F1 in `docs/plans/reports/T01-final-review.md`.  
**Produces:** layered reduced-motion override; no other semantic changes.  
**Verification:** `bunx biome check app/src/styles/heroui-theme.css`; static source/layer-order inspection; exact PRE/POST hashes. Expected exit 0 and no declarations outside the documented layers.

- [ ] Move the existing media block inside `@layer ob-theme` after light/dark mappings.
- [ ] Run the scoped Biome check and static layer/token audit.
- [ ] Return a report bound to POST; no browser success claimed.
