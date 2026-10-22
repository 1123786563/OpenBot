# T05-R1 independent final review

## Scope and verdicts

**Spec verdict: PASS at source level for T05-S1, T05-S2 and T05-S3.** The repair implements the three bounded findings in `T05-review.md` and the T05-R1 repair plan. Rendered browser acceptance remains deferred by user instruction.

**Code quality verdict: PASS for the reviewed repair delta.** No confirmed critical, high or medium production defect remains in these changes. This is an independent read-only review; no production source, test, locale, runner configuration or Git commit was changed by the reviewer. The report itself is the only reviewer-authored file.

Reviewed the T05 and T05-review briefs, original review, repair plan, `T05-R1-impl.md`, `T05-R1-S1-test.md`, the current three production components, both locales, the three relevant tests, runner registrations, and the final PRE/POST/delta package. Relevant requirements are P08–P15, especially P09 Bot context, P12 secondary-action hierarchy, and implementation-spec §8 retained content on background errors. This review does not reopen the original task's unaffected pages.

## Finding dispositions

| Finding | Verdict | Evidence |
| --- | --- | --- |
| T05-S1 — background profile error hides loaded page | Resolved | `app/src/components/bot-profile/bot-subpage.tsx:26,36–50` renders usable `agentData` independently of `agent.error`, adds an alert alongside it, and keeps the child in a stable fragment slot. Initial no-data failure retains the unreachable state. `app/tests/bot-subpage.test.tsx` loads through the actual query function, edits child-local React state with `userEvent.type`, asserts the visible state output before invalidating, and checks the input node and draft after failed refetch. |
| T05-S2 — SMS challenge crosses Bot context | Resolved | `app/src/components/delivery/reaching-you.tsx:66–111,157–162,319–325` stores a validated versioned object containing challenge, Bot and channel IDs, exposes the challenge only for the matching `fixedBot`, avoids clearing another Bot's saved challenge just by visiting, and clears it on successful confirmation. Malformed and legacy unscoped values are removed safely. `bot-reaching-you.test.tsx:237–298` checks persisted identity, the existing confirmation payload, and B-hidden/A-restored behavior. The sole production caller supplies the route Bot ID. No authorization or API contract was changed. |
| T05-S3 — routine secondary actions inline | Resolved | `app/src/components/routines/routines-list.tsx:398–459` keeps Run now direct and moves History/Delete into the existing DropdownMenu adapter. Existing history toggle, mutation reset and delete-confirmation callbacks are preserved. Both locales provide the trigger name. `routines-list.test.tsx` opens the menu and exercises History and Delete confirmation through the DOM. |

The repaired SMS test's A→B→A case initializes an existing challenge before rendering B and returning to A; the separate successful-send case verifies creating and confirming a challenge. It establishes the bounded source contract and does not claim real identity or tenant switching was tested.

## S1 invalid RED adjudication

The former `fireEvent.change` check established only the DOM input property and did not prove the child's React state changed. Its blank value after refetch was insufficient evidence of remounting. The corrected test explicitly verifies the visible `useState` output equals `Keep this draft` before refetch. The implementation report records the corrected targeted run passing, and the current test additionally checks input node identity and retained draft after the error. There is no basis for retaining the former test failure as a production finding. No additional production fix is warranted by that invalid RED.

## Final checkpoint integrity

The authoritative reviewed package is `docs/verification/workspace-redesign/execution/checkpoints/t05-r1/FINAL/`. Earlier `POST/` and root `delta.patch` predate the final S1 source/test and runner registration and must not be used as final evidence.

Independently recomputed SHA-256 and byte counts for all nine scoped paths. Each existing PRE snapshot matches `FINAL/PRE-manifest.json`; the two new tests have absent PRE tombstones. Each FINAL snapshot matches its POST manifest and the current live file. Regenerated the entire unified PRE→POST delta from these bytes and compared it exactly with `FINAL/delta.patch`; it agrees, including new files and runner registrations.

- PRE manifest SHA-256: `7a8676683b75542d3996665a7ee6c7cb76043359fd8ea11d8ad4e75b5f7ec7dd`.
- POST manifest SHA-256: `afeed9f4d663c304fe2f6e988b1dead1e7c32bef8d44f9958fca73088d7f7f53`.
- Exact regenerated delta SHA-256: `dca7edcd93f0ef5a48c206e21c431e510de84fafffcc4966b9c2f355017acca4`.

The first review pass detected stale POST coverage and incorrect locale PRE snapshot bytes. Parent restored locale PRE from clean HEAD blobs. Independently checked `git show HEAD` for both locale paths: their hashes equal the originally recorded PRE hashes (`ee1626…` and `ea4bbb…`). Rechecking the repaired PRE snapshots now succeeds. The runner PRE preserves the existing manifest and reverses only the two explicit test registrations. These evidence defects are resolved in FINAL and are not open production findings.

## Verification boundaries

This reviewer did not duplicate test execution. Existing implementation evidence records SMS and menu behavior tests, the ADR0008 driven partition, coverage audit and scoped Biome. The corrected S1 report records its targeted test passing. The earlier app typecheck failure was reported at unrelated `app/tests/button-native.test.tsx:54`; parent validation owns the final verification outcome and any later fix. Source review is bound to the final manifest above; new source changes require relevant revalidation and review.

Responsive geometry, browser keyboard/focus behavior, contrast, real permissions and rendered P08–P15 acceptance remain deferred. A Happy DOM menu test and adapter reuse do not establish browser acceptance. No browser test or real business-data operation was performed.
