# Routine and handoff Runs without Intelligence: OpenBot #37

Verified on November 26, 2026, at `eb066e592` on
`integration/intelligence-replacement-acceptance`, with main `e6da2df0b`
merged, plus the handoff fixes this change carries. `451ab43b3` holds
the roster fix and the assertions about the entry that the chained test first
committed at `0d29fb119` now carries; "Two gaps this change closes" below
names what the fixes changed. Each suite ran with `bun test --no-env-file
--timeout 120000 <files>` and one explicit `TEST_DATABASE_URL`, against one
disposable, migrated PostgreSQL. No Intelligence service, credential or
license was configured. Model responses, the model gateway, connectors and
sign-in identity were fixtures.

| Suite | Result |
| --- | --- |
| `server/tests/direct-chat.integration.test.ts` | 63 passed, 1934 assertions |
| `server/tests/agent-handoff-native-delivery.test.ts` | 12 passed, 38 assertions |
| `server/tests/person-response-turn.test.ts` | 5 passed, 12 assertions |
| `server/tests/resume-points.integration.test.ts` | 9 passed, 140 assertions |
| `server/tests/routines-store.integration.test.ts` | 63 passed, 151 assertions |
| `server/tests/routine-sweep.integration.test.ts` | 27 passed, 139 assertions |
| `server/tests/work-queue.integration.test.ts` | 18 passed, 41 assertions |
| `server/tests/agent-handoff.integration.test.ts` | 6 passed, 13 assertions |
| `server/tests/agent-handoff-runner.integration.test.ts` | 2 passed, 6 assertions |

No test in these suites failed or was skipped. Every file under
`server/tests` with `handoff` in its name, fifteen files, passed 151 tests with
486 assertions. The previous twenty-one-file changed-module importer sweep
passed 326 with 4819, and the nine routine, resume and approval suites passed
142 with 589. A broader sweep of those, the ask-person suites and the remaining
handoff files, plus the answer turn's unit file and the delivery turn's, fifty-one
files in all, passed 714 tests with 6240 assertions on a database migrated afresh.

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

## Two gaps this change closes

Both were found and left open on `451ab43b3`. Each fix was written test first:
the test failed against the code before it, and the counts above are the runs
that made it pass.

### The native delivery now carries the hop's signed statement

`createOpenBotHandoffDelivery` passed nothing to the Run it started, so
`coordinationForActor` built that Run's identity from the platform input: depth
zero, no `handoff` claim. A forward hop's Run was offered no coordination tool
at all, because its Bot is not the asking Conversation's own; the asking Bot's
notice Run, in its own Conversation, was offered `message_bot` and `ask_person`
at depth zero — the ask, fail, notice, ask cycle outliving a depth cap of 1.

The delivery now hands the runner's signed statement to the Run
(`BackgroundTurn.assertion`), and `execute` puts it on the run input as
`forwardedProps.openbotRun`. `handoffRunSigner` mints it for the delivery Run
id, `sha256(hopKey)`, so a coordination row in the trail cites the Run whose
answer it informed. The tools are offered and authorised from that statement:
its depth, its `handoff {key, owner}` claim, and the initiator that started the
chain. A Run at the deployment's cap is offered `ask_person` and no
`message_bot`; one below it may hand on, and the desk checks every call against
the live claim, so a statement whose hop has been finished coordinates nothing.

A Run handed on a second time runs in the conversation's own thread, so an
approval inside it is checked under that thread's Bot. The Bot that handed the
work on still has to grant it. Without this, the approval was refused even
though the Run was running in the thread the person was watching.

A delivered Bot's `ask_person` call carries the hop's claim to the escalation
route. Without it the route looked the source up by the asking Bot's id, which
is not the Conversation's own, and refused every question from a forward hop.
The question is now saved under the Conversation's own Bot, and that Bot's
turn carries the person's answer back.

The native delivery scopes a Run by the Bot whose thread it is, not by the Bot
that asked. Those are the same Bot on the first hop and different on the
second. With the thread's own Bot as the scope, a chain two deep runs in the
conversation the person is watching: its answer comes home under the Bot that
answered, and a failure notice is spoken by the Bot that asked and named in
the transcript when that is not the conversation's own.

The chained test reads the statement back at the answering Bot's endpoint —
bot and person, the delivery Run id, the asking Conversation, depth 1, the
Routine's origin, the hop's claim — and asserts the Run is offered
`ask_person` and not `message_bot`, this deployment's cap being 1. The notice
test asserts the same for a notice in a direct and in a shared Conversation,
and for a second-hop notice in both: the failed hop's depth and the notice
row's claim, `ask_person` offered, `message_bot` not.

The approval test suite adds a second-hop approval case: its pre-check allows
the approval where it was refused when scoped by the Bot that handed the work
on. The other seven withdrawal and recovery cases still pass.

A delivered Bot then calls `ask_person`: the saved question names the
Conversation's own Bot as its source, its entry says a question needs an
answer, and the tool was told it reached the person rather than refused. Two
more tests set the cap to 2 and run a two-hop chain in a direct and a shared
Conversation: the last Bot runs in the first Bot's thread, two deep, and its
answer lands there, relayed under its own name in the shared transcript.

Three changes each turn those red: the delivery not passing the statement (the
unit test's recorded turn has none, the endpoint's statement is a fresh
depth-zero one); `execute` not putting it on the input (the answering Bot is
offered nothing, the notice is offered `message_bot`); the statement minted for
a random id instead of the delivery Run's (the id read back does not match).

A change to the approval pre-check that scopes it by the handing Bot turns the
second-hop approval case red; the seven other cases stay green.

Three review-found changes each turn those red too: the escalation route not
given the claim (the delivered Bot's question is refused); the Run scoped by
the asking Bot instead of the thread's own (both two-hop chains and both
second-hop notices are refused); and a second-hop notice told without naming
the Bot whose words they are (the shared transcript loses that attribution).

### A failed hop's notice now reaches a shared Conversation

A hop that failed for good is put in front of the person by the asking Bot, in
the Conversation they are watching. Outside a budget the notice carries no
answer, so its Run is an ordinary turn of the asking Bot in its own thread. A
shared transcript takes a Routine's turn or a word-for-word answer only, so
nothing wrote that turn down, and the roster announcement withheld itself for
every shared Conversation because a relayed answer is already written in as its
own message. The notice reached nobody: its words existed only in the Bot's own
thread, which no member is shown.

A notice is now announced even in a shared Conversation, through
`announceHandoff`, under the thread's own Bot, with the notice Run's id as the
message id: a redelivered notice, or one whose worker was lost before it
answered, is written once, and two notices with equal words stay two. A relayed
answer is still not announced there, and a direct Conversation's entry is
unchanged. The announcement passes the same share check as every other Bot
message that reaches other people in a group.

The shared notice test reads both the transcript and the background-Run list:
the notice is the message, not a second "Run completed" bubble. A second-hop
notice is attributed to the Bot that spoke it, under the Conversation's own
Bot.

Two changes each turn that red: withholding the announcement for shared
Conversations (the unit test records no transcript line, and the shared test's
transcript stays empty), and telling without the Run id (the unit test sees no
id to tell two notices apart).

### A person's answer to a delivered Bot's question now resumes without Intelligence

A question asked under a Routine or a hand-off is queued even when the person
answers it in the open Conversation, because that turn has to keep the chain's
initiator and tools. The pass that runs a queued answer drove every turn
through the headless toolkit runner, which cannot open a thread on a
deployment with no Intelligence, so the answer ended in the pass's generic
failure and the asking Bot was never told. This is the same gap deliveries had
(issue #133), and it is closed the same way: the answer runs on the OpenBot
background engine, as the Conversation's own Bot's turn, under the question's
own initiator, one Run per answer (`sha256` of the answer's message id).

The integration test answers a delivered Bot's Routine-initiated question in
the Conversation and reads what the asking Bot is then told: one Run, the
question and the person's words verbatim, the Routine still named as the
initiator in the Run's statement, the reply in the transcript and in the entry,
the queued answer finished with no error, and a second pass that runs nothing.
The toolkit runner is wired to throw in that test, so the answer can only have
gone through the native branch. `person-response-turn.test.ts` reads the turn
itself over a recording engine: the words and initiator forwarded verbatim, a
person's initiator when the question had none, the same Run id however often
the sweep hands the answer out, an empty reply from a shared Conversation as a
delivery's is, the pass's own stop signal and last check before dispatch
handed on unchanged, and a refusal when there are no words to send.

A change that keeps the toolkit runner turns the integration test red (the
asking Bot is never called and the pass logs `Intelligence is not configured.`);
one that mints a fresh Run id per attempt turns the unit test red, and so
does one that drops the stop signal or that check.

## Limits of this evidence

- The chained handoff runs against a local AG-UI fixture on loopback, not a
  live Bot endpoint. The original Routine-to-handoff entry is proven end to
  end for a direct Conversation. The shared Conversation tests cover a
  delivered Run's notice and a two-hop chain with relayed answers, not a
  Routine firing in a group.
- A lost worker is simulated by starting a second worker and letting the first
  one finish late. No process was killed. A telling made again by a later
  delivery is shown by the redelivered hop in the chained test and by the unit
  file, not by a killed process.
- A telling that fails while the worker lives is not retried. The hop finishes
  and nothing delivers it again, so the entry keeps its line (or a shared
  transcript stays without the notice) until the person's next message. The
  miss is logged as `handoff-activity-unrecorded`, without the failed query's
  statement or the values bound to it.
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
- The signed statement has a ten-minute TTL for live tool callbacks. The
  native Run re-signs it on each attempt, keeping a previous statement that
  carries a `handoff` claim, and an approved action is read with the expiry
  ignored. A delivered Run paused on an approval for longer than ten minutes
  therefore keeps its depth and claim; it was checked in code, not run for
  longer than ten minutes.
- A hand-off that a delivered Run asks for, when the person's approvals
  intercept `message_bot`, is carried out from the statement in the approval's
  snapshot. The hop has been released between the busy retries that wait for
  the person by then, so `authoriseCoordinationRun` finds no active claim and
  refuses it. Before this change a notice's approved hand-off was sent from
  a depth-zero statement, which is the cycle this change closes; the
  deeper-cap path now refuses it rather than starting that chain again.
  The metered native delivery and the Intelligence delivery carry
  the same claim under the same rule, and no test on any of the three paths
  exercises an approval inside a delivered hop. Read from the code, not run.
  The default cap of 1 offers a delivered Run no `message_bot` at all, so this
  needs a deeper cap and an approval on delegation.
- A hop whose Run was dispatched and then failed leaves an unverified external
  outcome in the asking thread, and the notice that follows cannot run there
  until the outcome is reconciled. A delivered Run that hands on and then
  says nothing fails the same way ("Bot returned no text"), so the next Run
  in that thread is refused until the outcome is reconciled. The chain tests
  make the middle Bot say it handed the work on, as the tool's answer tells
  it to. Pre-existing and unchanged by this fix; read from the code, not run.
- No test starts `startHandoffDelivery` itself. Its signer's native branch
  is covered where the tests wire the runner and the delivery by hand with
  `handoffRunSigner(key, true)`; its Intelligence branch is unchanged and
  uncovered.
- The refusal-then-notice tests run the runner's account-unbound branch. An
  account-bound refused hop is reported as skipped without a notice, because
  that branch returns before `tell`. Read from the code, not run.
- The answer-resume fix is proven for a direct Conversation only. A question
  asked under a Responsibility still resumes through that Responsibility's own
  runner, which needs Intelligence and is unchanged. An answer the pass takes
  for a shared Conversation, which happens only for a person with an account,
  runs on the background engine but its reply is not written into the group
  transcript: the engine publishes only a Routine's turn or a relayed answer
  there, and the pass is handed back nothing to forward. Both read from the
  code, not run.
- The pass takes a queued answer once, for a person without an account. If the
  Conversation is busy when it does, because the person's own turn is still
  running there, the answer is released with that refusal and no later pass
  takes it again, while the question already shows as answered. That
  one-attempt rule predates this change and is what keeps an answer whose
  outcome is unknown from running twice. Read from the code, not run.
