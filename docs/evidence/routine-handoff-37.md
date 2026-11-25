# Routine and handoff Runs without Intelligence: OpenBot #37

Verified on November 25, 2026, at `97c4c2283` on
`integration/intelligence-replacement-acceptance`, with main `4a989395d`
merged. Each suite ran with
`bun test --no-env-file --env-file=.env.test <files>` against one disposable,
migrated PostgreSQL named by `TEST_DATABASE_URL`. No Intelligence service,
credential or license was configured. Model responses, the model gateway,
connectors and sign-in identity were fixtures.

| Suite | Result |
| --- | --- |
| `server/tests/direct-chat.integration.test.ts` | 53 passed, 1768 assertions |
| `server/tests/resume-points.integration.test.ts` | 9 passed, 140 assertions |
| `server/tests/routines-store.integration.test.ts` | 63 passed, 151 assertions |
| `server/tests/routine-sweep.integration.test.ts` | 27 passed, 139 assertions |
| `server/tests/work-queue.integration.test.ts` | 18 passed, 41 assertions |
| `server/tests/agent-handoff.integration.test.ts` | 6 passed, 13 assertions |
| `server/tests/agent-handoff-runner.integration.test.ts` | 2 passed, 6 assertions |

No test in these suites failed or was skipped.

| Criterion | Observed result |
| --- | --- |
| A Routine fires without Intelligence and its output, status and Run are linked | `Run now has the same Conversation Run after redelivery to a restarted worker` and `Run now completes in a shared Conversation` fire a Routine through `POST /api/routines/:id/run`. The Routine's run list and the Conversation's history both carry the same Run ID, and the Conversation holds the Run's reply. |
| The same trigger redelivered does not dispatch twice | Two sweeps racing on one due Routine offer it exactly once. The offer key is the Routine and the minute it was due, so a second pass over the same stamp adds no row, before or after the run. A finished queue item stays, so re-offering the same key runs nothing. |
| A handoff redelivered does not dispatch twice | The same hop offered twice leaves one row. A redelivered handoff appears once in a direct, a shared, and a shared Test Credit Conversation. |
| A worker is lost | Another worker resumes a direct-chat Run that was persisted before dispatch, and the original worker cannot dispatch it again. A restarted worker finishes a Routine Run, and running it again adds no dispatch. A Routine whose model outcome is unknown is reconciled without another reservation. An approval consumed by a worker that then disappears leaves the Routine Run failed with an unverified external outcome, and nothing is executed. A handoff whose lease went elsewhere is not run again by its old owner, and the tail of a batch is not delivered twice while its head is running. |
| A switched-off account starts no new work | After the person's access is revoked, the next Routine Run fails with `cannot run` and sends no reservation. A handoff from the desk cannot dispatch after the account goes unconfirmed. |
| Continuation rechecks approval, authorization and Credits | An approval that is allowed once completes the original Routine Run with one execution and one resume. A Run stopped by its owner, a person whose access is revoked after allowing, a worker lost while the approval was consumed, and a Skill version disabled by an administrator each leave the Run not completed, with nothing executed. A result that arrives after the Run was stopped is recorded as executed, and until it is reconciled a new turn is refused. A budgeted Routine or Task action requires human approval, and its follow-up continues only after the person confirms a budget. |
| An external action already sent is never sent again | A connector action whose answer was lost stays unconfirmed. Every later attempt stops without reaching the connector. |

## Limits of this evidence

- No single test chains a Routine into a handoff through the AG-UI path with
  Intelligence disabled. The Routine tests and the handoff tests each use the
  native path; the only chained test uses the earlier runner with a stub
  Intelligence.
- A lost worker is simulated by starting a second worker and letting the first
  one finish late. No process was killed.
- Run now refuses a second click while a Run is open. A request replayed after
  that Run has finished opens a new Run, because a manual request carries no
  trigger identity to redeliver. Scheduled triggers and handoffs do carry one.
- Account cutoff uses a revoked-access row and an unconfirmed account, not the
  target Casdoor or Suspension. Credits are a fixture ledger, not metered
  admission. Those remain open under #35, #158 and #51.
