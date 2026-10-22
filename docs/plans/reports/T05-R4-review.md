# T05-R4 Independent Review — SMS Conversation Test Follow-up

## Scope and evidence

Reviewed the approved HeroUI migration spec, P09 in the workspace page design, `CONTEXT.md`, ADR 0008, T05-R4 repair plan and implementation report, T05-R3-Q1, the archived T05-R4 PRE→POST delta, the current test, and `ReachingYou`. The current test SHA-256 (`335b169d…`) matches the archived POST. The delta changes only `app/tests/bot-reaching-you.test.tsx`, adding a UI selection, phone entry, SMS start request assertion, and persisted tuple assertion to the existing conversation-switch test. This is a static review; I did not rerun the implementer's reported 8/8 isolated tests or the driven wrapper, and did not invoke OCR.

## Finding

### T05-R4-Q1 — Low — The transition test inherits the preceding test's seeded challenge

- **Evidence / affected symbol:** `app/tests/bot-reaching-you.test.tsx:278–296` seeds `openbot.reachability.pendingSms` with `challenge-1` for Finance desk. The following transition test at `:298–349` starts without clearing that storage. The only `sessionStorage.clear()` is in the earlier phone test at `:240`; `afterEach` performs DOM cleanup and fetch restoration, not storage cleanup. `ReachingYou` reads storage on mount (`reaching-you.tsx:157`) and preselects its pending channel (`:374–376`). The SMS form and start action are available even with an existing challenge (`:490–528`). The mock also returns the same `challenge-1` for every write (`bot-reaching-you.test.tsx:50–63`).
- **Impact:** The test performs a real UI start request, but its initial code form and stored tuple can come from the prior seeded test. If the start response stops updating pending state, the subsequent storage, form, switch, and confirmation assertions can still pass using that old value. Thus T05-R3-Q1's requested end-to-end proof remains incomplete and the test depends on execution order.
- **Smallest defensible correction:** Clear `sessionStorage` at the beginning of the transition test, before `draw()`, then assert the pending key is absent before clicking **Send verification code**. Keep the start request, A→B→A, retained tuple, and original challenge confirmation assertions. A distinct returned challenge ID would add protection against stale state if this test later gains shared fixtures.

## Spec compliance verdict: PASS for product behavior; follow-up evidence incomplete

P09 requires the existing contact operation and verification feedback to remain available. The T05-R4 delta changes no product code or API, and the observed test path selects Finance desk and Team desk, two conversations containing the fixed `expenses` Bot (`bot-reaching-you.test.tsx:42–46`). The component gates the visible code form and confirmation ID on the selected pending channel (`reaching-you.tsx:406–409, 528–533`), while switching leaves the stored challenge intact. The test asserts the SMS start payload, full initial tuple, hidden code form on Team desk, retained Finance channel, restored form, and confirmation with `challenge-1`. The existing independent Bot switching test and prior phone start/confirm assertions are unchanged. The inherited seed prevents this particular test from proving that its own start response produced the pending value.

## Code quality verdict: PASS with one low behavioral-test gap

The archived delta is confined to one test and removes no assertion. No new product correctness, security, concurrency, data consistency, or architecture defect was found in this bounded change. The implementation report records an isolated 8/8 pass, scoped Biome and diff-check, plus a driven wrapper pass with shared-process warnings and a collection skip; those results are reported evidence, not independently reproduced here. T05-R4-Q1 should be corrected before treating the original low finding as fully closed.
