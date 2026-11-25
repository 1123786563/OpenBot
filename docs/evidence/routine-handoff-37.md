# Routine and handoff Runs without Intelligence: OpenBot #37

Verified on November 26, 2026, at `451ab43b3` on
`integration/intelligence-replacement-acceptance`, with main `4a989395d`
merged. `451ab43b3` holds the roster fix and the assertions about the entry
that the chained test first committed at `0d29fb119` now carries. Each suite
ran with `bun test --no-env-file --env-file=.env.test --timeout 120000 <files>`
against one disposable, migrated PostgreSQL named by `TEST_DATABASE_URL`. No
Intelligence service, credential or license was configured. Model responses,
the model gateway, connectors and sign-in identity were fixtures.

| Suite | Result |
| --- | --- |
| `server/tests/direct-chat.integration.test.ts` | 54 passed, 1811 assertions |
| `server/tests/agent-handoff-native-delivery.test.ts` | 10 passed, 32 assertions |
| `server/tests/resume-points.integration.test.ts` | 9 passed, 140 assertions |
| `server/tests/routines-store.integration.test.ts` | 63 passed, 151 assertions |
| `server/tests/routine-sweep.integration.test.ts` | 27 passed, 139 assertions |
| `server/tests/work-queue.integration.test.ts` | 18 passed, 41 assertions |
| `server/tests/agent-handoff.integration.test.ts` | 6 passed, 13 assertions |
| `server/tests/agent-handoff-runner.integration.test.ts` | 2 passed, 6 assertions |

No test in these suites failed or was skipped. Every file under
`server/tests` with `handoff` in its name, fifteen files, passed 149 tests with
480 assertions.

| Criterion | Observed result |
| --- | --- |
| A Routine fires without Intelligence and its output, status and Run are linked | `Run now has the same Conversation Run after redelivery to a restarted worker` and `Run now completes in a shared Conversation` fire a Routine through `POST /api/routines/:id/run`. The Routine's run list and the Conversation's history both carry the same Run ID, and the Conversation holds the Run's reply. One test chains the whole path: the asking Bot's Run answers with `message_bot`, the real runner and the real delivery hand the work to another Bot over the AG-UI tool path against a local fixture, and the Conversation then holds the delivered Run under the answering Bot's name (`assistantMessageId` from its Bot id and the delivery Run). Its entry in `/api/channels` carries that answer under the asking Bot's id, with no work left on it and a time equal to the latest event of the Run that answered. |
| The same trigger redelivered does not dispatch twice | Two sweeps racing on one due Routine offer it exactly once. The offer key is the Routine and the minute it was due, so a second pass over the same stamp adds no row, before or after the run. A finished queue item stays, so re-offering the same key runs nothing. |
| A handoff redelivered does not dispatch twice | The same hop offered twice leaves one row. A redelivered handoff appears once in a direct, a shared, and a shared Test Credit Conversation. A hop whose queue row went missing, offered again onto the Run that already answered, reaches no model. The roster is told again, of the same answer at the same time, and the entry stays where the first delivery left it. Offered once more with the Run's events deleted, it is told of when the Run started, and the entry stays there still. |
| A worker is lost | Another worker resumes a direct-chat Run that was persisted before dispatch, and the original worker cannot dispatch it again. A restarted worker finishes a Routine Run, and running it again adds no dispatch. A Routine whose model outcome is unknown is reconciled without another reservation. An approval consumed by a worker that then disappears leaves the Routine Run failed with an unverified external outcome, and nothing is executed. A handoff whose lease went elsewhere is not run again by its old owner, and the tail of a batch is not delivered twice while its head is running. |
| A switched-off account starts no new work | After the person's access is revoked, the next Routine Run fails with `cannot run` and sends no reservation. A handoff from the desk cannot dispatch after the account goes unconfirmed. |
| Continuation rechecks approval, authorization and Credits | An approval that is allowed once completes the original Routine Run with one execution and one resume. A Run stopped by its owner, a person whose access is revoked after allowing, a worker lost while the approval was consumed, and a Skill version disabled by an administrator each leave the Run not completed, with nothing executed. A result that arrives after the Run was stopped is recorded as executed, and until it is reconciled a new turn is refused. A budgeted Routine or Task action requires human approval, and its follow-up continues only after the person confirms a budget. |
| An external action already sent is never sent again | A connector action whose answer was lost stays unconfirmed. Every later attempt stops without reaching the connector. |

## The entry a delivered handoff moves

Without Intelligence a delivered handoff never moved the asking Conversation's
entry. `createOpenBotHandoffDelivery` ran the addressed Bot and recorded
nothing, so the entry kept the asker's own sentence and its old time. A
recording under the answering Bot was refused, because the roster admits only
a Bot that is in the Conversation.

The delivery now gives the roster the answering Bot's words under the
Conversation's own Bot. It does so on every delivery of the hop, so a worker
lost before it finishes the hop is replaced by a delivery that tells. It tells
of when the answer landed, because the roster only moves forward: a delivery
told again moves nothing. The time is the answering Run's latest event. A Run's
events go after an hour and its row stays, so once they are gone the time is
when the Run started, which the same database stamped before the answer and
which still moves nothing. Only a Run that cannot be read at all is told as
now.

`agent-handoff-native-delivery.test.ts` holds the delivery over stores that
only record and checks each part: the line, its Bot and its time; the same
line at the same time for a hop delivered again; nothing for a Run that said
nothing, that answered in a shared Conversation, or that did not happen; an
answer spoken back, and a notice, told under the Bot that speaks in the asking
Conversation; the Run's start time once the events are gone; now when nothing
about the Run can be read; a hop still reported delivered when the roster
cannot take the line, or the person cannot be looked up, with the miss logged;
a failed query logged without its statement or the values bound to it.

Eighteen changes to the delivery each turn a test red: no announcement;
announced as now instead of when the answer landed; a failing roster failing
the hop; a shared Conversation announced; announced under the answering Bot;
announced under no Bot; an event read that fails not tolerated; a Run row that
cannot be read not tolerated; no start time once the events are gone; the
events never read; told once per hop instead of on every delivery; the shared
transcript told for a direct Conversation; a Run that said nothing announced;
the miss not logged; the landing time read from the asking Bot's Run instead
of the answering one; the start time read from the application's clock instead
of the database's; a failed query's statement and values written to the log; a
person who cannot be looked up dropping the telling without a log.

## Two gaps on this path, found and left open

**The native delivery drops the hop's signed statement.** `HandoffDelivery.deliver`
receives `assertion`, the hop's statement carrying its depth, signed by the
runner. The Intelligence delivery forwards it to the Run it starts
(`forwardedProps.openbotRun`). `createOpenBotHandoffDelivery` never reads it,
so the delivered Run is signed by the runtime at depth 0 with no `handoff`
claim. The handoff tool is offered and authorized from that statement, so the
depth a hop has actually reached does not gate a native delivery. Two offers
were observed on the fixture deployment, whose depth cap is 1: with the
statement the runner signed, the addressed Bot would be offered `ask_person`
and nothing else; with the runtime's statement it is offered nothing only
because the Conversation's own Bot is the one that asked. A failed hop's
notice re-runs the asking Bot in its own Conversation, which _is_ the
Conversation's Bot, so it is offered `message_bot` again with no depth carried
(observed offer: `message_bot`, `ask_person`). Read together, those offers
allow an ask, fail, notice, ask cycle that outlives the intended cap on a
deployment that does not bill. The cycle itself was not run. A fix must mint
the statement for the delivery Run id and keep the hop's own initiator and
depth. It changes what a delivered Bot is offered, so it is not folded into
the roster fix.

**A failed hop's notice in a shared Conversation reaches nobody.** When a hop
fails for good, the runner queues a notice that re-runs the asking Bot in the
conversation the person is watching. Outside a budget the notice carries no
answer, so the native delivery runs it as an ordinary turn of the asking Bot.
In a shared Conversation that turn is not written into the shared transcript,
which takes a Routine's turn or a word-for-word answer, and the roster
announcement withholds itself there because a relayed answer is already written
in as its own message. On the Intelligence path the same notice is announced
into the transcript and the entry. This was read from the code, not run. A fix
needs a notice delivered in a shared Conversation under test first.

## Limits of this evidence

- The chained handoff runs against a local AG-UI fixture on loopback, not a
  live Bot endpoint. Its entry is proven end to end for a direct Conversation.
  A shared Conversation is covered only as far as nothing being announced and
  nothing being added to its transcript.
- A lost worker is simulated by starting a second worker and letting the first
  one finish late. No process was killed. A telling made again by a later
  delivery is shown by the redelivered hop in the chained test and by the unit
  file, not by a killed process.
- A telling that fails while the worker lives is not retried. The hop finishes
  and nothing delivers it again, so the entry keeps its line until the
  person's next message. The miss is logged as `handoff-activity-unrecorded`,
  without the failed query's statement or the values bound to it.
- A Run's events going after an hour was read from the code, not waited for.
  The chained test deletes the delivered Run's events by hand, and the unit
  file stands in for a failed read with one that throws; the hourly prune was
  not run. A delivery for which nothing about the Run can be read is told as
  now, and told that way again it lifts the old answer.
- The entry goes by the time each line is recorded, so the answer's line loses
  to any line recorded after it. That is the asking Bot's own sentence if the
  answering Bot's whole turn ends in the moment between the asking Run ending
  and that sentence being recorded, a line the browser reports late, or clocks
  that disagree by more than the answering turn. An answer settled onto a
  failed Run is told at that failure, so a line recorded in between keeps its
  place. None of these orderings was run.
- Run now refuses a second click while a Run is open. A request replayed after
  that Run has finished opens a new Run, because a manual request carries no
  trigger identity to redeliver. Scheduled triggers and handoffs do carry one.
- Account cutoff uses a revoked-access row and an unconfirmed account, not the
  target Casdoor or Suspension. Credits are a fixture ledger, not metered
  admission. Those remain open under #35, #158 and #51.
