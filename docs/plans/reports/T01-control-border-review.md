# T01 control-border cascade repair — independent review

## Review boundary and evidence

- Reviewed the T01 repair plan, `implementation-spec.md` §§2–3, `CONTEXT.md`, ADR 0008, implementation report, PRE/POST checkpoint records, and the two saved POST source files. HEAD remained `203d0f0244b2f898218fa12027089c631e8448d9`; this is an uncommitted checkpoint review, not a review of the entire dirty worktree.
- PRE SHA-256: `app/src/styles.css` `f32102564a7dc61180c38cd2e27c9d31bf0858ea04072d32f6199662868db8f3`; `app/tests/button-native.test.tsx` `f1b9e3811092ee55ff9fe13bae18f3531a4d01b528646b30c88152f183ff0c25`.
- POST SHA-256: `app/src/styles.css` `9a0343b337bd5f762c83eccdd55cfb5234487e998b4be6e8eb0f7a64865d142b`; `app/tests/button-native.test.tsx` `c94f81a149c93d264cf02f241b08752e28e59324baebeff204e9dcffffbcca86`. Current source and saved POST copies match these hashes. PRE lacks full file copies, but removing `layer(base)` from the POST HeroUI base import and removing the new Textarea assertion reproduces the recorded PRE hashes exactly; these are the complete task deltas.
- Implementation report records Biome and diff checks passing. The native report records 9 selected, 9 passed. The final `docs/verification/workspace-redesign/t01/control-border-repair/browser-validation.json` records twelve browser passes tied to the same POST hashes; all six listed screenshot paths exist. I did not rerun tests, browser automation, or OCR.

## Spec verdict

**Pass for the T01 delta against the specified token and cascade contract.** `app/src/styles.css:33` moves HeroUI's unlayered universal `border-color: var(--border, currentColor)` reset into the declared `base` layer, below `components` and `utilities`. This permits the existing explicit `--ob-control-border` classes on Input, Textarea, Select, Combobox, and outline Button to outrank the reset without changing token ownership or wrapper behavior. The new assertion at `app/tests/button-native.test.tsx:137` guards the Textarea wrapper's semantic class. The final browser record confirms all five controls at rest resolve to `--ob-control-border` in light and dark with 1px borders; Input, Textarea, Select, and Combobox show 8px computed radii. Focused Textarea separately resolves to `--ob-focus`. Escape and focus restoration are recorded in both themes. Outline Button radius measurement is limited by the browser profile's page zoom; this does not undermine the verified border token or the CSS class contract.

The implementation-spec file still labels itself "pending user review; not approved" at line 3. This review evaluates the technical contract cited by the assigned brief; approval provenance is for the controller to reconcile and is not a source-code finding.

## Quality verdict and findings

**Pass, with one low-risk future test-hardening recommendation; no blocking finding or code defect identified in the two-line delta.** The layer change is narrow, uses the existing declared order, and does not introduce `!important` or a wrapper-specific override. No security, concurrency, or data-consistency surface is changed.

### Q1 — Resolved for acceptance; low-risk regression-guard recommendation remains

- **Evidence / affected symbol:** `app/tests/button-native.test.tsx:137` checks only that Textarea's DOM class includes `border-[var(--ob-control-border)]`. That class was already present at PRE; the PRE and POST test results would be identical with respect to this assertion. The defect was the unlayered CSS reset at `app/src/styles.css:33` overriding that class in computed style.
- **Impact and resolution:** A future removal of `layer(base)` could restore the wrong border while all nine native tests still pass. The final browser record supplies the missing behavioral evidence for this POST checkpoint: resting Textarea computes `rgb(122, 135, 155)` = `#7a879b` in light and `rgb(104, 120, 143)` = `#68788f` in dark, with 1px border and 8px radius; the other four controls also match the proper theme token. The earlier medium acceptance gap is closed.
- **Smallest defensible future correction:** A focused driven browser assertion for the computed control border in both themes would make the regression guard persistent. This recommendation does not block T01 because the assigned browser validation has been completed against the exact source hashes.

**Final disposition:** Q1 is closed for T01 acceptance. The Combobox narrative now agrees with its light/dark pass entries, and `unverifiedSurfaces` is empty. The independent spec and quality verdicts for this two-file checkpoint are pass, subject only to the spec file's separate approval-provenance note above. This review found no reason to revert or broaden the CSS repair.
