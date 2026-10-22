# T05 P14 Save-Error Focus — Independent Review

## Scope and evidence

- Reviewed the P14 plan and assigned brief, the P14 page acceptance and B1-E/B1-I verification mapping, the HeroUI migration spec, `CONTEXT.md`, and ADR 0008. The production delta was compared with `docs/verification/workspace-redesign/b1-share-failure/checkpoints/PRE/sharing.tsx`; the current source SHA-256 is `389f96db1fe063c2e9ad2c9bc5de7e78d8f56731d1ab67e1c7b24ebb5feee6d5` and test SHA-256 is `88c1779886fdfaf9397c1ce67a583f72b4a7c35c76045dff10afaee302a309fd`, matching `VALIDATION.md`.
- Inspected `PublishDialog`, its Select and Dialog wrappers, the publication mutation, `bot-sharing.test.tsx`, and the recorded browser validation. This review did not rerun tests or browser checks and did not invoke OCR.

## Spec compliance verdict: Pass for the assigned P14 repair

`PublishDialog` now focuses its Audience Select trigger on a rejected publication mutation (`sharing.tsx:264, 299-304, 323-327`). It leaves the controlled audience, people, and groups state mounted and renders the mutation error (`sharing.tsx:270-274, 341-374`). The payload construction and successful close callback remain unchanged (`sharing.tsx:291-305`). The rejected-publication test checks the retained typed recipients, open dialog, alert, and one attempted request (`bot-sharing.test.tsx:183-214`). Recorded real-browser light/dark checks at 390×844 used a synthetic 503 on the exact PUT and observed Audience focus, Escape closure, trigger focus restoration, and zero API publication writes (`browser-validation.json`). This satisfies the bounded focus repair and the applicable B1-E/B1-I checks represented by that scenario.

This is a verdict on the repair, not the full P14 route matrix. The recorded browser scenario uses the default team audience; the wider permission, long-content, zoom, and other sharing states are outside this repair's validation record.

## Code quality verdict: Pass with one low-severity coverage gap

The error callback is local to the publication form, the ref is forwarded to the underlying Select trigger, and optional chaining prevents focus on an unmounted trigger. The Dialog's existing controlled close and focus-return path is used. The mutation still invalidates the same query keys after settlement. I found no critical, high, or medium correctness, security, concurrency, data-consistency, or architecture defect in this delta.

### Finding L1 — The automated regression does not exercise the repaired keyboard path or an update retry

- **Severity:** Low (missing behavioral coverage).
- **Evidence / affected symbols:** The new `bot-sharing.test.tsx:183-214` test asserts an alert, retained people/group values, an open dialog, and one attempted request, but never asserts focus, Escape dismissal, or a successful retry. It starts from an unpublished Bot. The only recorded focus and Escape browser check uses the default team audience (`browser-validation.json`), while the brief also calls for an unsuccessful update retaining selected audience and typed recipients.
- **Impact:** A later change that drops the `SelectTrigger` ref or error focus callback, or that loses an existing publication's recipient draft on retry, could pass the focused automated test. The recorded browser check proves the current focus behavior for the team-audience fixture; this is a regression-coverage gap, not a demonstrated production failure.
- **Smallest defensible correction:** Extend the rejected-save test or add one published-Bot update case: select specific people, type recipients, reject the first PUT, assert the selected audience and values plus active Audience trigger, dismiss with Escape and check focus return, then reopen and verify a successful update closes. Use the native/driven test entry specified by ADR 0008 when executing it. A real-browser people-audience check can cover any focus behavior that happy-dom cannot represent.

## Conclusion

The reviewed hashes satisfy the narrow P14 save-error focus repair. L1 is a low-severity test gap. Broader P14 acceptance remains governed by its separate route verification, and any subsequent source change needs a new hash-matched review.
