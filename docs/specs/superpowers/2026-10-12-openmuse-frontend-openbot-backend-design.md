# OpenMuse frontend on OpenBot: full capability design

> Status: proposed for review, 2026-10-12. This document replaces the staged scope and copied-client layout in `OpenMuse-Mobile-OpenBot-Backend.md` for the full integration. It does not authorize or describe a completed implementation.

## Purpose and acceptance

The existing OpenMuse application supplies the iOS, Android, and Web interface. OpenBot is the only business backend. A signed-in person can use the existing chat, task, Activity, Ideas, Goals, Mail, Calendar, Files, PDF, finance, and computer experiences without OpenMuse's server or worker running. The first self-hosted deployment supports roughly 1–20 simultaneously active people. Two distinct users with real Google test accounts must complete the acceptance flows on all three clients.

Existing `local-user` OpenMuse records and credentials are not migrated. The old instance may be retained separately. Feature parity applies to new users and new data. A demonstration state or an empty placeholder does not count as parity.

## Source layout

OpenBot references the entire existing OpenMuse repository as a Git submodule at `apps/openmuse`. The canonical client is `apps/openmuse/apps/mobile`; OpenBot's copied `apps/openmuse-mobile` subtree is removed after its relevant changes are reconciled with the source. `.gitmodules` uses the accessible OpenMuse remote (`https://github.com/1123786563/openmuse`), and OpenBot pins a committed OpenMuse revision. Uncommitted source changes cannot be included in that pin.

OpenBot's Bun workspace continues to build its own server and worker. The OpenMuse submodule uses its own pnpm workspace and lockfile. CI initializes the submodule, installs and checks the client from its repository root, and builds Web and native bundles separately. The integrated deployment does not start `apps/openmuse/apps/server` or `apps/openmuse/apps/worker`. Those source directories can remain temporarily as references while behavior is ported; deleting them is a separate cleanup decision.

## Ownership

| Concern | Owner |
| --- | --- |
| Rendering, navigation, forms, PDF viewer, client cache, unsent form input | OpenMuse client |
| User accounts, sessions, private Bot provisioning, Bot grants, channels, threads, chat history | OpenBot |
| Agent behavior and tools formerly implemented by OpenMuse `ConversationAgent` | OpenBot Bot implementation |
| Tasks, plans, runs, monitors, goals, ideas, memories, finance artifacts, task notifications | OpenBot domain modules |
| Google connection selection, mail/calendar domain interfaces, tool policy and audit | OpenBot plugin and domain modules |
| OAuth credentials and provider action execution | OpenConnector, accessed only through OpenBot |
| User files, PDF bytes, derived copies, artifact metadata, PDF processing | OpenBot file and document modules |
| Exact external-write proposals, approvals and receipts | OpenBot reviewed-action module |
| Browser, terminal, workspace and human control | OpenBot computer gateway and per-Bot computer |

OpenMuse's old HTTP adapter and server API are references for behavior and contracts, not runtime dependencies. The client has one authenticated OpenBot transport and one CopilotKit runtime. It must not infer user ownership from a client-supplied ID or call OpenConnector, Google, or the computer supervisor directly.

## Identity, Bots, and chat

Each OpenBot user signs in through Better Auth and receives one private OpenMuse Bot on first entry. Provisioning is idempotent and uses an administrator-managed template. Template revisions update common security settings and tool grants; user-editable profile fields remain their own. Each private Bot has its own OpenBot computer, browser profile, and workspace. Goals, ideas, memories, mail and calendar tools are granted only to that Bot unless a later explicit grant says otherwise.

OpenBot channels and Intelligence threads own chat history. The OpenMuse client maps the Bot, channel, runtime agent and thread IDs explicitly; it does not use the old fixed `default` runtime agent or `/api/main-thread` as an authority. Multiple chats, rename/archive/replay, run/stop/reconnect, streaming events and rich cards must continue to work. The existing assistant's behavior, prompts and tool intent are ported into an OpenBot-owned Bot implementation; no OpenMuse AG-UI server is deployed.

Native authentication must carry the current person's session through REST, CopilotKit runtime, file downloads and WebSocket computer streams. Web uses the OpenBot origin and credentialed requests. `OPENBOT_SINGLE_USER` is not valid for multiuser acceptance. Logout clears client caches and media access.

## OpenConnector and Google

OpenConnector is the selected connector path. The current live provider directory includes Gmail and Google Calendar actions and OAuth configuration. The current OpenBot adapter still filters out OAuth2 and chooses `custom_credential`, which for these providers is a Workspace service-account form rather than an individual's Google consent. OpenBot must extend its OpenConnector adapter and connected-account UI to support per-user OAuth start, callback, connection status, refresh and disconnect using OpenConnector's supported OAuth lifecycle. The OpenBot user ID selects a stable, server-derived named connection; the client cannot choose another person's alias. Credentials and provider tokens remain in OpenConnector's encrypted store.

The OpenMuse UI consumes stable OpenBot mail and calendar contracts, not OpenConnector's dynamic action schemas. OpenBot maps search/read/thread/attachment and calendar list/read to connector actions, preserving truncation, time zones and account identity. It maps send and event create/update/delete through the reviewed-action module. Every operation checks the user's connection, the private Bot's grant and policy. If a required action or OAuth scope is unavailable in the deployed OpenConnector version, the feature fails visibly; acceptance requires the actual Google workflow to pass before cutover.

The original OpenMuse Google tokens are outside the accepted data migration scope. New users connect their accounts in OpenBot. Google sign-in to OpenBot is not required; account login and Gmail/Calendar authorization are separate.

## User files, PDF, and finance

OpenBot needs a user-owned file and artifact interface. Channel attachments are scoped to a conversation and currently reject PDF; Craft files support PDF but are scoped to a Craft session. Neither alone represents OpenMuse's long-lived Files page. A file record has a stable user owner, original and derived version IDs, MIME type, size, content hash, storage location, task/artifact references and deletion state. Backend authorization guards list, upload, content, download and share operations. File bytes remain in OpenBot-managed durable storage; short-lived URLs or authenticated streams serve the viewer.

The OpenBot document module ports PDF field inspection, unsupported-field reporting, deterministic fill-copy creation, mail-attachment import and computer-workspace transfer. It never overwrites the original. The OpenMuse client retains its Web/native PDF reader and field-entry interface, but does not parse or fill PDF as business authority. The finance module ports CSV validation and spending-summary calculation; OpenBot stores the resulting tracker artifact and task association.

## Tasks, reviews, and Activity

A dedicated OpenMuse Task module in OpenBot owns `agent`, `document`, `monitor`, `finance` and `plan` jobs. It reuses OpenBot's work queue and headless Bot runner, while adding the explicit task states, plan steps, run events, typed evidence and artifact references required by the existing UI. It owns pause/resume/cancel/retry, waiting input, waiting review, lease-loss recovery and scheduled monitoring. A monitor retains its condition, observation cursor, deduplication key and failure backoff. A task has one execution authority; the old OpenMuse TaskWorker is not started.

The reviewed-action module ports OpenMuse's exact external-write checks into OpenBot: proposal hash, expiry, target version, Google account and connection generation, atomic claim, receipt, and `outcome_unknown` reconciliation. An uncertain send or calendar update is never retried automatically. OpenBot computer policy approvals remain a distinct decision type. A single Activity response presents both with a type and source; the relevant module executes the decision. Task status changes create OpenBot notifications with per-user read state.

Document tasks keep the full flow: select a message and PDF attachment, import and inspect fields, request missing values, produce a filled copy, prepare a reviewed reply, wait for decision, execute once, then save a receipt and task outcome. Background work is initiated by OpenBot with the owner and private Bot context even when the client is closed. Computer actions always use the OpenBot gateway, policy and audit, including during a headless run.

## Client seam

The OpenMuse client replaces its `/api/session` Bearer login, `MuseApi` transport, `/api/workspace` bootstrap and fixed `/api/copilotkit` owner with OpenBot session, workspace and runtime contracts. Direct upload, PDF, screenshot and signed-content calls are included in that change. Stable OpenBot facades supply Mail, Calendar, Files, Goals, Ideas, Tasks and Activity data in shapes the UI can render. The client may adapt presentation data and perform local form validation; authorization, domain transitions and execution stay in OpenBot.

`apps/openmuse-mobile` in OpenBot is a source of already attempted client adaptations, but it is not a second maintained frontend after the submodule switch. Its changes are compared with current `openmuse/apps/mobile` before removal so that useful auth and API work is not lost.

## Deployment, deletion, and recovery

The self-hosted stack runs OpenBot API/worker, PostgreSQL, OpenConnector with encrypted durable credential storage, and per-Bot computer infrastructure. OpenMuse contributes client artifacts only. Private computers start on demand and have explicit concurrency, disk and idle limits for the 1–20 user target. OpenConnector's public OAuth callback origin must be reachable by Google while its admin and runtime interfaces remain restricted to the backend network. Secrets are never shipped in mobile bundles.

Deleting a user immediately disables sessions, the private Bot, queued/running tasks and Google connections. A durable deletion record allows recovery of private files and business data for 30 days, then removes them from OpenBot, OpenConnector and file storage with retryable cleanup. Backups must have a compatible retention limit. Restoration never silently restarts cancelled external writes.

## Delivery order and acceptance

1. Reconcile frontend sources, pin the OpenMuse Git submodule, remove the copied subtree, and make CI/build paths reproducible.
2. Establish OpenBot session, private Bot provisioning, channel/thread mapping and one client transport on iOS, Android and Web.
3. Extend OpenBot's OpenConnector adapter for per-user Google OAuth, then add stable mail/calendar read and reviewed-write contracts.
4. Add user files, PDF processing, finance artifacts and computer file transfer inside OpenBot.
5. Add the OpenMuse Task and personal-context modules, port the assistant tools and task workflows, then aggregate Activity and notifications.
6. Switch all existing client screens to OpenBot data and run live acceptance before declaring cutover.

Acceptance uses at least two OpenBot users and two real Google test accounts on iOS, Android and Web. It checks cross-user isolation of Bots, computers, connections, files and memories; multiple chat threads and run/stop/reconnect; all five task kinds and restart recovery; monitor deduplication/backoff; PDF import/fill/view/workspace transfer; approved, denied, expired, changed-account and uncertain external writes; policy refusal and human control; deletion, 30-day recovery and final cleanup. Existing OpenMuse server or worker running during acceptance is a failure of the single-backend design.

## Existing documents and evidence

- Earlier staged integration documents: `OpenMuse-Mobile-OpenBot-Backend.md`, `OpenMuse-Mobile-OpenBot-Backend-Architecture.md`, `OpenMuse-Mobile-OpenBot-Backend-GoLive.md`. They cover a smaller initial scope and copied client layout; this design supersedes those assumptions for full integration.
- Current client migration record: `apps/openmuse-mobile/MIGRATION.md`.
- OpenMuse decisions: `CONTEXT.md` and `docs/adr/0004` through `0010` in the OpenMuse repository. ADRs 0001–0003 were superseded when the sole-backend direction was selected.
- OpenConnector OAuth contract: <https://github.com/oomol-lab/open-connector/blob/main/docs/credentials.md>.
