# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary (inferred from README emphasis, unconfirmed): the engineering team or company that clones the repository — they deploy it, replace the example tenant package with their own coworkers/channels/skills, configure model credentials, and keep changing it. OpenBot is a template they own, not a service they subscribe to.

Secondary: their coworkers — the people who talk to a Bot in its channel, watch it work on its own screen, take the wheel at approvals, and hand it back.

Open decision: none confirmed beyond the README's own framing.

## Product Purpose

OpenBot is a self-hosted AI coworker platform: the shape of ChatGPT/Claude/Grok, with the difference that it runs on the user's own infrastructure and can be changed in every part. Docker Compose brings up the whole thing, data sits in the user's PostgreSQL, no model ships in the box (an administrator supplies the key, encrypted at rest, never logged). A deployment starts with two coworkers as configuration (General Assistant, Knowledge), grows from a catalog of one-job examples, or from `/agents` in the UI. Success means a company can operate, govern, and continuously reshape AI coworkers entirely on machines it controls.

## Positioning

Governance rides the protocol, not the framework: any endpoint speaking AG-UI arrives as a coworker with a channel of its own, whether built on LangGraph, Mastra, CrewAI, Pydantic AI, Google ADK, or by hand. Every tool action to a computer, file, MCP server, or component passes through one gateway that resolves the target, decides it against policy, records an audit row, and only then acts — or refuses and names the rule. Each coworker gets its own computer: a per-Bot container with its own Chromium, logins, and workspace, built by the supervisor. "A template, not a product": there is no hosted version and nothing is published as a package to depend on — you clone, replace `examples/` with your own, and run.

## Operating Context

- Development starts on a laptop: Docker for PostgreSQL and shipped Bots, Bun 1.3+ for app and API server, `.env` with `OPENBOT_SINGLE_USER=true` admitting every request as one administrator; OAuth sign-in is required before anyone else can reach the deployment.
- A CopilotKit Intelligence project (free plan available, self-hostable) carries threads; model keys are per-deployment.
- Operators work in the browser app: Bots and their live screens, skills, routines, approvals, memory, channels (Slack), admin (including the audit log), and a marketplace/billing surface under construction on the current branch.
- Answers arrive as components (AG-UI generative UI), not only prose.
- Customization surface: copy agents from `examples/fintech/catalog/`, write them in `agents.yaml`, or create from the UI.

## Capabilities and Constraints

- AG-UI protocol is the integration contract; governance is enforced at the gateway regardless of agent framework.
- Supervisor builds and owns one container per Bot (own Chromium, logins, workspace); browser/file actions reach that computer only after a policy decision.
- Audit rows land in PostgreSQL for every decided tool action.
- Alpha status, active development; expect rough edges. MIT licensed. By CopilotKit.
- No hosted version; nothing published as installable packages; every workspace in the repository is private.
- Desktop (Tauri) and mobile targets exist in the repo as packaging of the same product; the design surface of record is the web app (`app/`).
- Open decision: marketplace and billing (Lago payments, metering events) are in progress on `feat/observability-p1` — positioning and scope not yet settled.

## Brand Commitments

- Name: OpenBot. Backed by CopilotKit (copilotkit.ai/openbot).
- Voice (from README, durable in code comments too): plain-spoken, engineering-honest, understated; names its own limitations ("Alpha, and under active development"; "a template, not a product"); no marketing inflation.
- No brand assets or identity constraints beyond the name have been declared binding.

## Evidence on Hand

- `README.md` — product claims, quick start, architecture diagrams (light/dark SVG).
- `docs/` — architecture, coworkers, configuration, deployment, observability, routines.
- `prompt.txt` — checked setup instructions for AI assistants.
- `examples/fintech/catalog/` — twelve one-job coworker examples.
- Demo video and architecture diagrams under `assets/`.
- Absence to respect: no named customers, testimonials, benchmarks, or case studies exist; future work must not fabricate them.

## Product Principles

1. **Ownership is the product.** Everything runs on infrastructure the user controls; if it needs a hosted account they don't control, it doesn't ship.
2. **Decide before acting, record after.** No tool action reaches a computer, file, or server without a policy decision and an audit row. Trust is built at the exact moment someone hands over credentials.
3. **The protocol is the lock-in escape.** Framework-agnostic by AG-UI; nothing in the platform may assume a particular agent stack.
4. **A template, not a product.** Designed to be cloned, renamed, and reshaped into the owner's own thing — the example tenant package is the seam.
5. **Quiet over loud.** The interface stays out of the way while state changes underneath it; alpha honesty over polish theater.
