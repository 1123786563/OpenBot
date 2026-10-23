# T01 Control Boundary Cascade Repair Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development`; one frontend implementer, then independent validation and review. No commits.

**Goal:** Make the computed border for shared fields, select/combobox triggers, and outline buttons resolve to `--ob-control-border` as specified.

**Facts:** `implementation-spec.md` §2 and §3 require the control boundary token. Authenticated browser evidence in `.archive/runs/2026-10-20-workspace-redesign-b1/verification/t01/` shows Input, Textarea, Select, Combobox and outline Button currently compute `--ob-border` in both themes despite wrapper utility classes. CSS matched-rule inspection identified an unlayered HeroUI base reset competing with layered wrapper utilities.

## Global Constraints

- Preserve all existing dirty work and current HEAD `203d0f0244b2f898218fa12027089c631e8448d9`.
- No commits, dependency installs, OCR, or unrelated design changes.
- Scope to cascade correction and targeted behavioral/style contract tests only.

## Task 1 — Repair cascade and guard contract

**Owner:** frontend_implementer. **Validator:** frontend_validator. **Reviewer:** reviewer.

**Files:** `app/src/styles.css`; `app/tests/button-native.test.tsx` only if a focused assertion needs updating. Avoid wrapper-by-wrapper `!important` fixes. Preserve existing control variant behavior.

**Consumes:** implementation spec; browser computed-style evidence; current stylesheet layer order.

**Produces:** base reset has intended lower cascade precedence (or equally narrow evidence-backed correction), allowing component and utility layers to set control boundaries. Add/update a focused regression assertion that shared wrappers retain the semantic token contract.

**Verification:** scoped Biome; targeted native E2E test; `git diff --check`; then authenticated Chrome computed styles in light/dark for Input, Textarea, Select trigger, Combobox trigger and outline Button. Each must match `--ob-control-border`, remain 1px/8px, and preserve focus/Escape restoration. Capture JSON and screenshots.

**Failure handling:** if moving the base import changes unrelated typography/reset behavior, revert only this task's delta and choose a narrower cascade fix; report the measured conflict. No broad visual override.
