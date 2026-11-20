# OpenBot Domain Map

This map was derived from the current product description, application routes, server modules, and database schema. It identifies the domain contexts that a change may cross. Read the glossary for each affected context before changing domain behavior.

## Contexts

| Context | Glossary | Primary code surfaces | Owns |
| --- | --- | --- | --- |
| Identity and workspace | [`docs/domain/identity-and-workspace/GLOSSARY.md`](docs/domain/identity-and-workspace/GLOSSARY.md) | `server/src/auth/`, `server/src/identity/`, `server/src/people/`, `server/src/team-bots/`, `server/src/db/schema/core.ts`, `server/src/db/schema/identity.ts`, `server/src/db/schema/team-bots.ts` | People, organizations, roles, Bot visibility, sharing, and edition-specific workspace behavior |
| Conversation and Bot runtime | [`docs/domain/conversation-and-bot-runtime/GLOSSARY.md`](docs/domain/conversation-and-bot-runtime/GLOSSARY.md) | `server/src/channels/`, `server/src/agents/`, `server/src/channels/group.ts`, `server/src/voice/`, `server/src/db/schema/core.ts`, `server/src/db/schema/group.ts`, `server/src/db/schema/voice.ts` | Conversations, channels, threads, turns, Bot runs, handoffs, attachments, and model choice |
| Governance and capabilities | [`docs/domain/governance-and-capabilities/GLOSSARY.md`](docs/domain/governance-and-capabilities/GLOSSARY.md) | `server/src/approvals/`, `server/src/components/`, `server/src/admin/`, `server/src/audit.ts`, `server/src/db/schema/approvals.ts`, `server/src/db/schema/components.ts`, `server/src/db/schema/admin.ts` | Capabilities, tools, skills, grants, approvals, policies, and audit events |
| Computer and browser | [`docs/domain/computer-and-browser/GLOSSARY.md`](docs/domain/computer-and-browser/GLOSSARY.md) | `server/src/browser/`, `server/src/computer/`, `server/src/host-access/`, `server/src/recorder/`, `server/src/passwords/`, `server/src/db/schema/computer.ts`, `server/src/db/schema/recorder.ts`, `server/src/db/schema/passwords.ts` | Bot computers, browser sessions, pages, credentials, recording, host access, policies, and snapshots |
| Connections and integrations | [`docs/domain/connections-and-integrations/GLOSSARY.md`](docs/domain/connections-and-integrations/GLOSSARY.md) | `server/src/plugins/`, `server/src/delivery/`, `server/src/db/schema/plugins.ts`, `server/src/db/schema/delivery.ts`, `server/src/identity/` | External accounts, identities, plugins, MCP tools, authorization, and delivery channels |
| Memory, learning, and responsibilities | [`docs/domain/memory-learning-and-responsibilities/GLOSSARY.md`](docs/domain/memory-learning-and-responsibilities/GLOSSARY.md) | `server/src/memory/`, `server/src/learning/`, `server/src/responsibilities/`, `server/src/proactive/`, `server/src/db/schema/memory.ts`, `server/src/db/schema/learning.ts`, `server/src/db/schema/responsibilities.ts`, `server/src/db/schema/proactive.ts`, `server/src/db/schema/demonstrations.ts` | Retained information, learning, demonstrations, learned skills, responsibilities, proactive work, and suggestions |
| Automation and delivery | [`docs/domain/automation-and-delivery/GLOSSARY.md`](docs/domain/automation-and-delivery/GLOSSARY.md) | `server/src/routines/`, `server/src/tasks/`, `server/src/work/`, `server/src/delivery/`, `worker/src/`, `server/src/db/schema/coworker.ts`, `server/src/db/schema/tasks.ts`, `server/src/db/schema/work.ts`, `server/src/db/schema/delivery.ts` | Routines, runs, work items, tasks, triggers, and message delivery |
| Platform administration | [`docs/domain/platform-administration/GLOSSARY.md`](docs/domain/platform-administration/GLOSSARY.md) | `server/src/setup/`, `server/src/config.ts`, `server/src/db/`, `server/src/edition.ts`, `server/src/model-availability-check.ts`, `server/src/auth/`, `charts/`, `desktop/`, `mobile/`, `extension/` | Deployment, edition, model access, identity providers, enterprise settings, migrations, and client surfaces |

## Cross-context relationships

- A **Person** uses a **Bot** through a **Conversation**. Identity and workspace owns the participants and sharing rules. Conversation and Bot runtime owns the exchange and execution.
- A **Bot run** may invoke a **Tool** or **Computer** action. Governance and capabilities decides whether the action is available. Computer and browser performs the action.
- A **Tool** may come from a **Plugin** or **MCP server**. Connections and integrations owns the external authorization needed to use it.
- An **Approval** can pause a **Bot run**. Governance and capabilities owns the decision. Conversation and Bot runtime owns the user-visible continuation.
- A **Routine**, **Responsibility**, or **Proactive check-in** creates **Work items** and may produce a Conversation or Delivery message. Automation and delivery owns dispatch. Memory, learning, and responsibilities owns the source behavior.
- A **Memory source** or **Learned skill** changes the context available to a Bot run. Memory, learning, and responsibilities owns the retained behavior. Conversation and Bot runtime consumes it.
- A **Delivery binding** maps a Conversation or Bot to an external channel. Connections and integrations owns the external identity. Automation and delivery owns inbox, outbox, and dispatch state.
- Platform administration supplies the deployment, model provider, authentication, database, and edition boundaries in which every other context operates.

## Route map

The primary web surfaces are grouped under these boundaries:

- Bot and conversation work under `app/src/routes/_authed/_app/`
- Bot administration under `app/src/routes/_authed/admin/`
- Personal settings under `app/src/routes/_authed/settings/`
- Bot profile pages under `app/src/routes/_authed/_app/bots.$agentId.*.tsx`
- Connections under `app/src/routes/_authed/_app/connections*`
- Routines under `app/src/routes/_authed/_app/routines*`
- Capabilities, skills, memory, reachability, and responsibilities under `app/src/routes/_authed/_app/`

## Modeling notes

- **Bot** is the central aggregate across the product, but its profile, runtime, computer, grants, memory, routines, and delivery behavior belong to different contexts.
- **Identity** has two meanings in the code. A workspace person identity controls access to OpenBot. An external identity represents a provider-side account or authorization. Keep those meanings explicit in changes.
- **Skill** has two meanings in the product. A reusable Bot behavior is a learned or managed skill. A framework or package skill is an agent instruction for development. Domain code should use `learned skill` or `managed skill` when the product meaning needs to be clear.
- **Task**, **work item**, **routine run**, and **responsibility run** represent different levels of execution. Do not collapse them into a single generic job term without checking the owning context.
