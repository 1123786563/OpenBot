# OpenMuse on OpenBot: product and integration spec

> Status: published as [openmuse#1](https://github.com/1123786563/openmuse/issues/1) with `ready-for-agent`. Source: the OpenMuse integration conversation, accepted OpenMuse ADRs 0004–0010, the shared glossary, and the integration design of 2026-10-12. This is a new-user cutover; it does not migrate legacy single-owner records.

## Problem Statement

People using OpenMuse need its full chat, task, Activity, Ideas, Goals, Mail, Calendar, Files, PDF, finance, and computer experiences with an account that is private to them. Today these experiences depend on OpenMuse's own server and worker, while OpenBot already owns the target account, Bot, conversation, computer, job, policy, and connector platform. A partial UI connection would leave files, Google consent, offline tasks, and reviewed external changes with different owners and inconsistent recovery.

The existing OpenMuse client must become a frontend for OpenBot. The integrated product must work for roughly 1–20 concurrently active people in a self-hosted deployment, with real isolation across users and with no OpenMuse business server or TaskWorker running.

## Solution

An OpenBot user signs in on OpenMuse for iOS, Android, or Web. OpenBot creates that user's private OpenMuse Bot on first entry. The client displays OpenBot-owned Channels, Threads, tasks, personal context, Google data, files, computer activity, and decisions through stable authenticated interfaces. OpenBot runs background work and owns every business transition. OpenConnector executes Gmail and Google Calendar provider actions after each user separately authorizes their Google account. External writes require a Reviewed action; computer policy decisions remain Policy approvals. One Activity view presents both kinds without combining their decision rules.

The existing OpenMuse repository remains the canonical frontend and is referenced by OpenBot as a Git submodule. OpenBot's copied client is removed after relevant changes are reconciled. The first cutover requires parity for new data and new users; historical single-owner OpenMuse data is outside this migration.

## User Stories

1. As a person, I want to sign in with an OpenBot account on iOS, so that my OpenMuse work belongs to me.
2. As a person, I want to sign in with the same account on Android, so that I can continue my work there.
3. As a person, I want to sign in on Web, so that I can use the same workspace from a browser.
4. As a person, I want my session to survive an app restart, so that I do not lose my place.
5. As a person, I want logout to remove cached private data and media access on that device, so that the next user cannot see it.
6. As a new person, I want a private OpenMuse Bot to appear automatically, so that I can begin without administrator setup.
7. As a person, I want my Bot's description and preferences preserved when its common security template is updated, so that my customization survives.
8. As an administrator, I want common grants and safety settings to reach existing private Bots, so that policy stays consistent.
9. As a person, I want my Bot's browser, computer, and workspace isolated from other people's Bots, so that private content cannot cross accounts.
10. As a person, I want to create, switch, rename, and archive Channels, so that I can organize conversations.
11. As a person, I want each Channel's Thread and history restored, so that a conversation continues after reconnecting.
12. As a person, I want streaming replies, tool progress, rich cards, and clear failures, so that I can understand what my Bot is doing.
13. As a person, I want to stop a running reply and reconnect without duplicate messages, so that interrupted work remains understandable.
14. As a person, I want the existing OpenMuse assistant behavior and personal tools on my private Bot, so that the familiar experience continues.
15. As a person, I want to connect my own Gmail and Google Calendar after OpenBot sign-in, so that my Bot can work with my accounts.
16. As a person, I want to see which Google account is connected and disconnect it, so that I control its access.
17. As a person, I want to search and read mail, threads, and attachments, so that I can use Mail inside OpenMuse.
18. As a person, I want to browse calendar events in my time zone, so that their dates and times are trustworthy.
19. As a person, I want to see the exact recipient, content, account, and target before mail is sent, so that I can approve the intended change.
20. As a person, I want to review event creation, updates, and deletion before they happen, so that my calendar is not changed unexpectedly.
21. As a person, I want denial, expiry, account changes, and uncertain provider outcomes handled explicitly, so that a rejected or ambiguous write is not silently retried.
22. As a person, I want Policy approvals and Reviewed actions in one Activity view with their types clear, so that I can make the right decision.
23. As a person, I want to upload, list, open, download, and manage my files across Channels and tasks, so that Files is a durable personal library.
24. As a person, I want to import a PDF from a mail attachment, so that I can work on a document received by email.
25. As a person, I want supported PDF fields identified and unsupported fields reported, so that I know what can be filled.
26. As a person, I want a filled PDF saved as a new version while the original remains available, so that I can inspect both.
27. As a person, I want to view PDFs on Web and mobile and move a task artifact to my Bot's workspace, so that I can inspect and use the result.
28. As a person, I want to create a one-off agent task and see its steps, evidence, and outcome, so that work can continue after I leave the app.
29. As a person, I want a document task to request missing values, prepare a filled copy and reviewed reply, and wait for my decision, so that completion is deliberate.
30. As a person, I want a finance task to validate a CSV and calculate a spending summary, so that its result is reproducible and saved.
31. As a person, I want to create a plan with visible steps and outcomes, so that a longer job is understandable.
32. As a person, I want a recurring monitor with a condition, schedule, and notifications, so that I learn when the condition is met.
33. As a person, I want to pause, resume, cancel, and retry eligible tasks, so that I can control background work.
34. As a person, I want a task waiting for input or review to remain visible after restart, so that I can finish it later.
35. As a person, I want monitor observations deduplicated and failures backed off, so that I do not receive repeated or runaway work.
36. As a person, I want Goals, Ideas, and memories associated with my private Bot, so that it can use my context without exposing it to another Bot.
37. As a person, I want task notifications with read state, so that I can find new results and clear what I have seen.
38. As a person, I want to see and take control of my Bot's computer under OpenBot policy, so that I can intervene when needed.
39. As a person, I want account deletion to stop sessions, Bot work, tasks, and Google access immediately, so that no more activity occurs in my name.
40. As an administrator, I want mistaken account deletion recoverable for 30 days and final cleanup afterward, so that recovery and retention have clear bounds.
41. As a self-hosted operator, I want a reproducible build from the OpenMuse submodule and one OpenBot backend, so that I can deploy and upgrade consistently.
42. As a self-hosted operator, I want bounded computer and worker capacity for 1–20 active users, so that one user's work cannot exhaust the installation.
43. As a self-hosted operator, I want connection, task, cleanup, and uncertain-write failures visible, so that I can repair them safely.

## Implementation Decisions

- OpenBot is the sole business backend and authority for accounts, Bots, Channels, Threads, tasks, files, personal context, Google connection selection, approvals, reviewed actions, notifications, and computer access. OpenMuse owns rendering, navigation, forms, document viewing, and local interaction state only.
- OpenBot references the complete existing OpenMuse repository as a Git submodule. The canonical client is built from that submodule; the copied client is reconciled and removed. A submodule pins a committed revision, so uncommitted local changes must be resolved before the integration pin.
- Every user gets one private OpenMuse Bot through idempotent first-entry provisioning. Administrator template revisions update common security settings and grants while preserving user-editable fields. The private Bot owns a separate computer, browser profile, and workspace.
- The client has one authenticated OpenBot transport and one CopilotKit runtime. OpenBot derives ownership from the authenticated session, never a client-selected user identifier. Bot, Channel, runtime agent, and Thread identities are mapped explicitly.
- OpenBot ports OpenMuse assistant behavior and tool intent into its Bot implementation. Personal tools are granted to the private OpenMuse Bot; access by other Bots requires an explicit future grant.
- OpenConnector is the sole Google connector path for this integration. OpenBot adds individual OAuth authorization, callback, status, refresh, and disconnect flows through OpenConnector and derives each person's connection alias server-side. OpenConnector retains provider credentials; the client never calls it directly.
- OpenBot exposes stable Mail and Calendar domain contracts over connector actions. Reads preserve account identity, pagination or truncation, and time-zone semantics. Provider action shapes do not leak into the client interface.
- External Gmail and Calendar changes pass through a Reviewed action with exact proposal content, target version, account and connection generation, expiry, atomic claim, receipt, and an explicit uncertain-outcome state. An uncertain write is never automatically retried. Policy approval remains a separate decision type; Activity aggregates both.
- OpenBot adds durable user-owned files and artifacts with stable IDs, versions, authorization, task links, deletion state, and storage. PDF inspection, fill-copy production, attachment import, and workspace transfer run on the backend. The original PDF is preserved.
- OpenBot ports finance CSV validation and calculation and stores resulting artifacts. Business calculations do not depend on client state.
- A dedicated Task module owns agent, document, finance, plan, and monitor tasks with steps, runs, typed evidence, artifacts, waits, retries, cancellation, leases, and restart recovery. It reuses OpenBot's queue, headless Bot runner, computer gateway, policy, and audit interfaces.
- Goals, Ideas, memories, and task notifications are OpenBot-owned and scoped to the user and private Bot. Notifications have per-user read state.
- Account deletion immediately disables access and work and disconnects Google. Private records remain recoverable for 30 days, then retryable cleanup removes them and their file and connector data. Backup retention must respect this boundary.
- The integrated deployment runs OpenBot API and worker, PostgreSQL, OpenConnector, and per-Bot computers. It does not run OpenMuse's old server or TaskWorker. The old source may remain temporarily for reference.

## Testing Decisions

- Test user-visible outcomes and persisted transitions through the highest practical seam: the OpenMuse client against authenticated OpenBot interfaces and a real self-hosted integration stack. Avoid assertions on internal method calls, queue implementation, or connector schema internals.
- The main acceptance path uses two distinct OpenBot users and two real Google test accounts on iOS, Android, and Web. It verifies that each user sees only their own Bot, computer, connection, files, tasks, and personal context.
- Backend contract checks cover login and ownership, idempotent Bot provisioning, Channel–Thread mapping, Mail and Calendar reads, file authorization, task state transitions, monitor deduplication, deletion, and recovery.
- Reviewed-action checks cover approval, denial, expiry, changed account or target, concurrent claims, provider timeout, uncertain outcome, and receipt reconciliation. Computer Policy approvals receive separate checks.
- Task checks cover all five task kinds, background execution with the client closed, restart and lease-loss recovery, input and review waits, pause/resume/cancel, evidence, and notifications.
- Document and finance checks cover mail-attachment import, supported and unsupported PDF fields, non-destructive fill copies, artifact access, CSV validation, and calculation outputs.
- Client checks cover session restoration, logout cleanup, navigation and rendering, run/stop/reconnect, PDF viewing, and Activity decision presentation on each platform.
- Existing prior art includes OpenBot's authorization, channel, account, computer, and UI behavior checks; OpenMuse's mobile date, response, conversation-queue, computer-status, and PDF-related client checks; and OpenMuse's worker lifecycle checks. These inform cases but do not substitute for integrated behavior checks.
- Cutover is accepted only when the full experience works without the old OpenMuse server or worker. Stub screens and demonstration data are not evidence of parity.

## Out of Scope

- Migrating historical single-owner OpenMuse records, credentials, and task history.
- Retaining an OpenMuse business service, OAuth token store, file store, or TaskWorker in the integrated runtime.
- Using Composio or a separate Google provider path for this integration.
- Sharing a private user's personal tools with arbitrary public Bots.
- Physically deleting the old OpenMuse server and worker source during the first cutover; they are excluded from deployment.
- Supporting a higher concurrency target than approximately 1–20 active users in the first self-hosted release.

## Further Notes

- This spec consolidates the accepted decisions in the OpenMuse glossary and ADRs 0004–0010. ADRs 0001–0003 were superseded by the sole-backend decision.
- The earlier staged integration and copied-client documents remain historical implementation references; their reduced scope is not the acceptance scope here.
- OpenBot's present OpenConnector adapter selects custom credentials for Google providers. Individual OAuth integration is required before live Gmail or Calendar acceptance.
- Current OpenBot Channel attachments and Craft files do not alone supply the durable personal Files and PDF workflow described here.
- The acceptance seam is the authenticated OpenMuse client against OpenBot APIs and durable state, exercised by two users with distinct Google accounts across iOS, Android, and Web. This is the working test-design assumption from the accepted end-to-end cutover scope.
