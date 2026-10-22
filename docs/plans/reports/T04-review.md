# T04 independent Spec and quality review

## Scope and evidence

- Reviewed the PRE→POST delta at `docs/verification/workspace-redesign/execution/checkpoints/t04/delta.patch` (SHA-256 `fb6dfa2e0a51c120610e3ad97eaf8a345806fc522cc33e1752d78370c0b6503f`). Its four paths are `bot-roster.tsx`, `profile.tsx`, `manage.tsx`, and `bot-manage.test.tsx`.
- Verified all 22 files in each PRE and POST source snapshot against their manifest hashes; all 22 current live files also match POST (zero mismatches). Compared the delta with P06/P07 route acceptance, approved implementation Spec §§4–5, layout contract, CONTEXT.md, ADR0008, and the T04 brief/report.
- This is a source and test review. Rendered overflow, computed style, focus, zoom, and theme acceptance remain unverified as stated in the brief. No tests or OCR were run for this review.

## Spec findings

### S1 — Medium — Bot detail hides required long content

**Evidence:** P07 `long_content` requires a 120-character name and 300-character description and says the full content must be readable on the detail page. `app/src/components/bot-profile/profile.tsx:92–100` adds `line-clamp-2` to the name, title, and role description. This component is the only read display of `roleDescription` in the Bot profile; the remaining occurrence is an edit field in `setup.tsx`. The new clamp cuts off long descriptions and names after two lines without an expansion or full-text affordance.

**Impact:** A person reading a long Bot profile cannot see the full identity and role description required by P07. The layout change converts a long-content acceptance case into silent truncation.

**Smallest defensible correction:** Allow the detail identity text to wrap in full (`break-words` can remain), or provide a keyboard-accessible expansion that reveals the full text. Keep the roster summary clamped separately.

## Quality findings

### Q1 — Low — New behavioral coverage misses the changed long-content paths

**Evidence:** The four-file delta adds only the section-placement assertion at `app/tests/bot-manage.test.tsx:93–103`. It does not exercise the changed roster name/summary, action area, or profile identity with long content. P06/P07 explicitly require long strings and 390px/200% reachability; browser acceptance is deferred, so the reported 12 native passes and driven partition do not establish these outcomes.

**Impact:** The truncation in S1 and any action displacement can survive the current automated tests. This is a coverage gap, not a claim that rendered overflow occurs.

**Smallest defensible correction:** Add a focused source/DOM behavioral assertion that full profile text remains available, and complete the planned browser matrix for roster/action layout before marking P06/P07 accepted.

## Verdicts

- **Spec compliance: Fail for T04 source acceptance.** S1 conflicts with P07 full-content readability. The delta otherwise preserves the existing `groupRoster` precedence/actions, folded hidden group, route/API behavior, and Delete permission/confirmation path by source inspection; the roster row has a 64px minimum and nonshrinking trailing area. Rendered P06/P07 acceptance is pending.
- **Code quality: Conditional pass with a low coverage finding.** No security, concurrency, data consistency, or architectural regression was found in the four-file delta. Q1 leaves the changed long-content behavior without a targeted check.
