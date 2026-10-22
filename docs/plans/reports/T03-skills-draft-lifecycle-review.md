# T03 Skills draft lifecycle — independent Task 1 review

## Reviewed checkpoint

- HEAD: `203d0f0244b2f898218fa12027089c631e8448d9` (unchanged, uncommitted Task 1).
- `app/tests/skills-draft-lifecycle.test.tsx`: SHA-256 `50c612d3450bf0864d09283439fea60ff6bf11af82b03fd02008ca06eeda0391`.
- `docs/plans/reports/T03-skills-draft-lifecycle-impl.md`: SHA-256 `fc58c08cd99e55bfe3eac6abcf347b5c8c988eeac57a072f2f98fed60f3e6007`.
- Both live files match the POST checkpoint copies byte for byte. Reviewed against the Task 1 plan and brief, `implementation-detail.md` §4–6, the B1 plan's T03 acceptance, ADR 0008, the approved migration spec, and `CONTEXT.md`.

## Finding

### Medium — Narrow Sheet branch does not prove draft retention

**Evidence / symbol:** `app/tests/skills-draft-lifecycle.test.tsx:146–162`, the test `new skill title and dirty state survive the DetailPanel breakpoint`. At width 879 it asserts only that a dialog exists. It checks the entered title and `data-dirty="true"` before any resize and after the final return to 880. It checks route search only at the end. A Sheet render that drops or resets the field at 879, then recovers it from the route owner at 880, would pass these assertions. The Task 1 plan's Review Focus and brief require value, dirty state, and open route after each branch transition; the implementation report's broad retention claim is stronger than the actual assertions.

**Impact:** The regression does not establish the user-visible draft state while the narrow Sheet is open, which is one of the two remount boundaries under review. It also leaves the intermediate navigation/close state unobserved.

**Smallest defensible correction:** Immediately after the 879 dialog assertion, query its title input and form, assert the entered value and `data-dirty="true"`, and assert `/skills` with `{ new: true }`. Repeat the route-state assertion after the 880 transition. If the explicit `onClose=0` acceptance is claimed, add a direct observable close/navigation call assertion or clearly limit the claim to unchanged route state.

## Verdicts

- **Spec compliance: incomplete.** The test uses the production Skills route, cache keys, public `userEvent.type`, and the DetailPanel observer transition. It proves final restoration after 880. The missing 879 assertions leave the Task 1 acceptance unproven.
- **Code quality: pass with one medium coverage defect.** The test uses the native ADR 0008 entry point and a real route rather than a synthetic draft owner. No security, data consistency, or production architecture defect was identified within the assigned test and report. The medium finding must be addressed before this Task can be signed off.

## Scope and evidence limits

This was a read-only source review of the specified test and implementation report, with checkpoint hash and byte comparison. I did not run tests, OCR, or browser acceptance. The implementation report records one native E2E file/test passed, Biome passed, and `git diff --check` passed; those execution results were not independently reproduced here. Browser geometry, scroll preservation, mount count, other DetailPanel consumers, and production source correctness are outside this Task 1 review.

## R1 scoped re-review

**Checkpoint:** Live test SHA-256 `d12f7640e9607692538d44e63bf9b370c254bfa3d51824e060a8591be5f719f9`; live implementation report SHA-256 `e7f49c3a795d1e144e31b36252eba06a3e0d882f1abc39e2d96911af8bd1b6ac`. Both equal `POST-R1/hashes.txt` and match its saved copies byte for byte. Compared with the original POST copy, the test change is confined to assertions at the 879 branch.

**Original medium finding: resolved for draft and route state.** At `app/tests/skills-draft-lifecycle.test.tsx:148–158`, the test obtains the dialog after resizing to 879, reads the title input within that dialog, and asserts its entered value, the enclosing form's `data-dirty="true"`, `/skills`, and `{ new: true }` before resizing back to 880. Lines 164–172 retain the equivalent assertions after returning to 880. This closes the original gap in observable state at both branches.

**Remaining evidence limit:** The test observes unchanged route state at each transition, but does not directly count `onClose` or navigation calls. Thus it supports “the route stayed open” and does not prove the stricter `onClose=0` wording in `implementation-detail.md` §4 or the Task 1 plan's no-close-callback clause. If that direct claim is needed for Task 1 sign-off, add an observable call count around the resize sequence; otherwise describe the evidence as route-state preservation. This is a medium, narrowly scoped acceptance gap, not evidence that a close callback actually fired.

**Report metadata note (low):** The implementation report's R1 section quotes its own SHA-256 as `eb4e6a23…`, whereas the checkpoint manifest and live bytes are `e7f49c3a…`. Use the POST-R1 manifest hash for the final ledger; avoid embedding a document's own hash inside that same document.

**R1 Spec verdict: partially satisfied.** Draft value, dirty state, and route state are now asserted at 879 and 880. The explicit zero close-callback claim remains unverified by the test. **R1 quality verdict: pass with the bounded evidence and metadata limits above.** The repair adds assertions only, preserves the production-route/public-input seam, and introduces no identified security, concurrency, or data-consistency concern within this review scope. The implementation report records 1 native E2E test collected and passed plus Biome and diff checks; this reviewer did not rerun those commands.

## R2 scoped re-review

**Checkpoint:** At final review, live test SHA-256 `0532d91ed21f36d9ff48fa26396c4a19394b3337c12f9af1ff42bd5fa6f27b20` and live implementation report SHA-256 `aad0426674029483f10303bf00c03b01e6afe007405a93b2cd5665ea96baadf3` match `POST-R2/hashes.txt` and the saved POST-R2 copies byte for byte. HEAD remains `203d0f0244b2f898218fa12027089c631e8448d9`.

### Medium — Navigation observation stops before the return transition

**Evidence / affected symbol:** `app/tests/skills-draft-lifecycle.test.tsx:153–172`, the R2 history subscription in `new skill title and dirty state survive the DetailPanel breakpoint`. It subscribes after initial route resolution and asserts zero history events at 879 (line 170), but unsubscribes at line 171 before the `resize(..., 880)` call at line 172. Thus the public history count covers 880→879 but not the full 880→879→880 sequence required by the R2 plan and brief. The final route-state assertion would not detect a navigation event that returns to the same URL.

**Impact:** The test cannot support the implementation report's claim of zero public history notifications across the complete resize sequence, or close the R1 side-effect gap for the return transition.

**Smallest defensible correction:** Keep the subscription active through the final 880 resize and final route/draft assertions; assert `navigationEvents === 0` there, then unsubscribe in a `finally` block so assertion failures cannot leak the listener.

**R2 Spec verdict: incomplete.** The R1 draft and route assertions remain sound at both widths, and R2 adds a public history observation for the first transition. The zero-navigation acceptance for the complete sequence remains unproven. **R2 quality verdict: one medium test-lifecycle defect.** No production security, concurrency, data-consistency, or architecture issue was identified within the assigned scope. The implementation report records one native E2E test collected/passed, Biome passed, and diff check passed; this reviewer did not rerun those commands. OCR and browser acceptance were not performed.

## R3 scoped re-review — final Task 1 checkpoint

**Checkpoint:** Live test SHA-256 `4ca41cfe0f822eeebe1bcfd7a87ddd7357a51e23901c75a29741c8319a400c2c` and implementation report SHA-256 `8203fed73ea2ef3c7e69472c0ace896d0642b8d87fb5b94e7c608edfb5d3e8c8` match `POST-R3/hashes.txt` and its saved file copies byte for byte. HEAD is unchanged at `203d0f0244b2f898218fa12027089c631e8448d9`.

**R2 medium finding: resolved.** In `app/tests/skills-draft-lifecycle.test.tsx:153–189`, the history subscription begins after the initial route resolves, remains active for 880→879→880, and checks `navigationEvents === 0` after both the 879 dialog and return to 880. Unsubscription is inside `finally`, so an assertion or resize failure still releases the listener. The title, dirty state, and `/skills` `{ new: true }` assertions remain at both branches. Relative to POST-R2, the test diff only extends the listener lifetime and adds the final count assertion.

**R3 Spec verdict: pass for Task 1.** The production-route Happy DOM test now covers the brief's draft retention and public history side-effect requirements across the complete resize sequence. **R3 quality verdict: pass.** No unresolved medium or higher finding remains in the assigned test/report scope. The earlier low report self-hash metadata note remains historical; the POST-R3 manifest and independently computed live hashes agree and are the reliable checkpoint identifiers. The implementation report records one native E2E test collected/passed plus Biome and diff checks; those commands were not rerun by this reviewer. Browser geometry, other consumers, and OCR remain outside this scoped review.
