# CUA enterprise engineering capability research

Date: 2026-10-24. Sources are first-party CUA documentation and repository files. “Verified” means explicitly documented; “inference” is an architectural implication, not a CUA guarantee.

## Product boundaries and architecture

- **Verified:** CUA is a set of layers, not one hosted Agent product: Cua Driver operates native desktop apps and browsers; Cua SDK/CLI manages local or remote sandboxes; Cua Spaces provides full desktops and human/agent collaboration; `cua-spacesd` is the in-sandbox daemon. CUA does not include an agent loop; the integrator supplies the agent/harness. Sources: [repository README](https://github.com/trycua/cua), [SDK overview](https://cua.ai/docs/cua-sdk).
- **Verified:** The SDK has a Rust core with Python, TypeScript and Rust bindings, and can run embedded in-process or through a shared `cua daemon`. The daemon shares sandboxes, environment connections, tunnels, streams and credentials across processes. [SDK architecture](https://github.com/trycua/cua/blob/main/libs/cua/README.md).
- **Verified:** `cua-spacesd` exposes gRPC/gRPC-Web on port 3211, filesystem signed URLs, MCP over HTTP, ticketed tunnel WebSockets, and media streaming on port 3212. [spacesd README](https://github.com/trycua/cua/blob/main/libs/cua-spacesd/README.md).

## Runtime, OS and isolation options

- **Verified:** Local runtimes include Docker/Podman, gVisor when installed, QEMU, and Lume on Apple silicon. OCI images are supported; containers use host architecture, while other runtimes can emulate. [SDK overview](https://cua.ai/docs/cua-sdk), [SDK architecture](https://github.com/trycua/cua/blob/main/libs/cua/README.md).
- **Verified:** Canonical images cover Linux, Windows and macOS; macOS VM use requires Apple silicon in the documented quickstart. [Sandbox README](https://github.com/trycua/cua/blob/main/libs/python/cua-sandbox/README.md), [quickstart](https://cua.ai/docs/cua-cli/quickstart).
- **Verified:** CUA supports local, direct-address and relay/account machine references. Direct connections use an environment token; the SDK can connect to any reachable `cua-spacesd`. [SDK reference](https://cua.ai/docs/cua-sdk).
- **Inference:** This gives an enterprise deployment a choice between per-tenant containers, stronger VM isolation for untrusted work, and customer-owned machines. CUA does not by itself define OpenBot-style tenant, Bot or business-scope ownership.

## Authorization and policy controls

- **Verified:** Every Driver call from CLI, MCP, SDK or daemon goes through a runtime authorization check. Checks are layered: hard invariants, built-in risk map, managed policy, user policy, permission mode, capability manifest and (where needed) a launch grant/host decision. [Permissions guide](https://cua.ai/docs/cua-driver/guides/permissions).
- **Verified:** `standard`, `bounded` and `unrestricted` modes exist. `bounded` requires an approved capability manifest and is intended for unattended agents/gateways; unrestricted bypasses approval checks and is explicitly unsafe for prompt injection. [Permissions guide](https://cua.ai/docs/cua-driver/guides/permissions).
- **Verified:** Policies can be YAML or Rego, are deny-by-default when configured, load at startup, and invalid/missing policy prevents daemon startup. Managed and user policies both apply. Policies restrict calls and arguments but do not authenticate callers, rate-limit, filter responses, or protect code running in the same process. [Permissions guide](https://cua.ai/docs/cua-driver/guides/permissions).
- **Verified:** Sessions can be revoked individually or globally; revocation removes grants, browser bindings, recordings and cursor state. [Permissions guide](https://cua.ai/docs/cua-driver/guides/permissions).
- **Enterprise implication:** OpenBot must remain the source of tenant identity, user authorization, approval records, budgets, and operation-level audit. CUA policy is an execution guard, not a SaaS authorization system.

## Human control, recording and audit-related surfaces

- **Verified:** Spaces supports multiplayer human/agent operation with separate cursors, streaming, and handoff. Teleport can move a signed-in app session after user approval; the Cua Keyvault encrypts sessions on the Mac. [Repository README](https://github.com/trycua/cua), [Cua product page](https://cua.ai/).
- **Verified:** Driver standard mode allows recording to validated paths; recordings are tied to session cleanup/revocation. A `DriverActivityObserver` exposes content-free activity events to embedding hosts. [Permissions guide](https://cua.ai/docs/cua-driver/guides/permissions).
- **Limitation:** These are runtime and activity controls. The cited docs do not claim a complete immutable enterprise audit trail containing tenant, actor, approval, business object, external result, retention or legal hold. OpenBot would need to capture those facts around each action.

## Lifecycle, persistence and recovery

- **Verified:** Sandbox connection lifetime and sandbox lifetime are separate: disconnecting does not stop a sandbox; deleting destroys it and its state. `ephemeral` deletes on block exit; `create` persists until deleted (subject to provider time limits); local suspend/resume exists. [Sandbox lifecycle](https://cua.ai/docs/cua-sdk/concepts/how-sandboxes-work).
- **Verified:** The current `cua-sandbox` 0.9.1 docs say `Sandbox.snapshot()` is unavailable. The documented cloud capacity service ended on 18 October 2026; current operation is local or customer-owned infrastructure. [Sandbox lifecycle](https://cua.ai/docs/cua-sdk/concepts/how-sandboxes-work), [sandbox README](https://github.com/trycua/cua/blob/main/libs/python/cua-sandbox/README.md).
- **Verified:** The Driver has a default five-minute idle session TTL; ended sessions reject stale calls until explicitly restarted, and element tokens/snapshots from ended sessions remain invalid. [Driver contracts](https://github.com/trycua/cua/blob/main/docs/content/docs/reference/cua-driver/contracts.mdx).
- **Inference:** Reliable long-running business work must persist its own checkpoints and artifacts outside the desktop session. CUA can stop/resume or reconnect environments, but it does not make an in-memory GUI state an authoritative business checkpoint.

## Enterprise deployment and operations

- **Verified:** CUA can run on a customer’s Mac, Linux server, spare machine, LAN/Tailscale endpoint, or customer-owned AWS/GCP/Modal setup; `cua host setup` can make a machine reachable through the relay without inbound port forwarding. [Repository README](https://github.com/trycua/cua), [SDK guide](https://cua.ai/docs/cua-sdk).
- **Verified:** Readiness is provider status plus explicit probes (TCP/HTTP); the SDK is agentless and can run shell/files/services/streams only when the relevant guest service exists. [How sandboxes work](https://cua.ai/docs/cua-sdk/concepts/how-sandboxes-work).
- **Verified:** Driver can run as a persistent daemon for external MCP/CLI clients; platform permission handling differs, especially macOS TCC permissions. [Keep Driver running](https://github.com/trycua/cua/blob/main/docs/content/docs/how-to-guides/driver/keep-running.mdx), [serve/configure](https://cua.ai/docs/cua-driver/reference/cli/serve-and-configure).
- **Operational gap:** The official material describes primitives and deployment recipes, not a complete multi-tenant control plane with quotas, autoscaling, SLOs, centralized logs/metrics, fleet placement, secrets rotation, backup policy or incident response. Those remain platform responsibilities.

## API and integration maturity

- **Verified:** Python, TypeScript and Rust SDKs are available; gRPC contracts are available for other languages. The Rust workspace defines generated protobuf services for system, process, filesystem, computer, windows, accessibility, driver, streams, presence, teleport, tunnels and volumes. [SDK overview](https://cua.ai/docs/cua-sdk), [SDK workspace](https://github.com/trycua/cua/blob/main/libs/cua/README.md).
- **Verified:** Readiness probes, service requests, signed file URLs, port forwarding and MCP endpoints are first-class integration surfaces. [Sandbox reference](https://cua.ai/docs/cua-sdk/reference/sandbox), [spacesd README](https://github.com/trycua/cua/blob/main/libs/cua-spacesd/README.md).
- **Inference:** OpenBot can wrap these APIs behind its Computer adapter, keeping business approval and tenancy in OpenBot while treating CUA as an execution provider.

## Licensing and commercial risk

- **Verified:** The root license is MIT unless a subdirectory has its own license. Cua Driver, SDK/CLI/daemon, `cua-sandbox`, Lume and `cua-bench` are listed as MIT. Cua Spaces apps, `cua-spacesd`/relay, Keyvault, Teleport, Cua Volume, media protocol/transport/client/codecs/viewers, and Cua Driver Bench are listed as FSL-1.1-MIT. FSL permits self-hosting but restricts competing commercial services; each release converts to MIT after two years. Optional `cua-som` and perception model artifacts have AGPL obligations. [Current per-directory licensing inventory](https://github.com/trycua/cua/blob/main/legal/LICENSING.md), [repository README](https://github.com/trycua/cua).
- **Correction:** The earlier summary called the streaming protocol MIT, following a conflicting high-level README sentence. The current per-directory license inventory and package LICENSE files identify `cua-media-protocol` and `cua-media-transport` as FSL; use those specific license files when evaluating integration.
- **Recommendation:** For a commercial OpenBot product, prefer MIT Driver/SDK/CLI components first. Verify exact dependency and artifact licenses before embedding Spaces, streaming, perception artifacts, or offering a managed service based on FSL components.

## What CUA supplies vs what OpenBot must supply

| Enterprise concern | CUA supplies | OpenBot still needs |
| --- | --- | --- |
| Desktop execution | Cross-OS Driver and desktop primitives | Task planning, business workflows, domain adapters |
| Isolation | Containers, gVisor option, QEMU/Lume VMs | Tenant/Bot identity binding, network/data policy, image governance |
| Execution authorization | Runtime modes, YAML/Rego policies, capability manifests, revocation | User/team scope, approval and delegation, payer/budget checks |
| Human handoff | Streaming, multiplayer, separate cursors, teleport approval | Handoff state machine, fencing, evidence and consent records |
| Lifecycle | Create/connect/suspend/resume/restart/delete, readiness probes | Durable checkpoints, idempotency, unknown-result reconciliation, retention |
| Audit | Activity observer and recordings | Immutable business audit, retention, export, legal/compliance controls |
| Fleet operations | Local/customer-cloud/relay placement primitives | Quotas, scheduler, autoscaling, health dashboards, SLOs, incident tooling |
| Secrets | Keyvault/approved teleport and environment tokens | Tenant-scoped secret store, rotation, provider OAuth lifecycle |

## Bottom-line assessment

CUA is a strong execution substrate for OpenBot when the product needs isolated desktops, native apps, human takeover and multiple operating systems. It is not an enterprise SaaS control plane. The clean boundary is: OpenBot owns identity, business scope, approvals, task ledger, persistence, billing and audit; CUA owns the desktop runtime, low-level operation policy, streaming and environment lifecycle.
