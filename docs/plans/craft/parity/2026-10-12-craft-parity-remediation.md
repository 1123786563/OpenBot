# Craft Parity Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenBot's TypeScript Craft surface reproduce the observable Onyx Craft behavior, prompt, tool availability, configuration, call chain, and output formats for the reviewed gaps.

**Architecture:** Preserve OpenBot's Hono, OpenCode, and agent-sandbox transport, but add a per-user managed-content resolver and a controlled tool/runtime layer. Generate each session's AGENTS.md and opencode.json from the same resolved capability snapshot; push skills and plugins before an OpenCode instance starts, and dispose/reload it when that snapshot changes. Restore Onyx's webapp and archive contracts at the existing Craft routes.

**Tech Stack:** TypeScript, Bun, Hono, OpenCode serve, agent-sandbox, Drizzle/Postgres, Redis where configured. No Mastra dependency is needed for this path.

**Spec:** User's request for a one-to-one TypeScript port of `/Users/wuyongjun/trea/onyx` Craft, and the source-code review in this conversation (2026-10-12). Reference design: `docs/specs/superpowers/2026-10-10-craft-workshop-design.md`. That design deliberately omits some Onyx capabilities; for this Craft parity remediation, the user's explicit parity requirement supersedes those omissions. Do not silently generalize this decision to the separate Workshop product.

## Global Constraints

- Review Onyx source at a pinned commit SHA and record OpenBot BASE before implementation; compare behavior to code, not completion documents.
- Keep the Onyx AGENTS.md behavioral instructions and rendered placeholders byte-equivalent except for environment facts that cannot be true in OpenBot; enumerate every substituted sentence and test it.
- Credentials remain outside agent-readable workspace files. External app calls must be scoped to the current user/session, use existing approval and audit mechanisms, and preserve Onyx's 403 no-retry behavior.
- All Craft routes retain their current ownership checks. Do not alter unrelated Bot, channel, or Workshop flows.
- Do not commit without existing authorization. Use SDD uncommitted checkpoints if commit authorization is absent; preserve unrelated working-tree changes.
- A passed unit test or typecheck alone does not prove parity. Verify real OpenCode tool discovery and one full session flow against controlled fixtures.

## Review Focus

1. A user with no connected apps must see the same fallback prompt and no stale MCP tools; test in Task 2.
2. A user whose MCP permission changes during a live session must get a reloaded OpenCode instance and the new tool set; test in Task 3.
3. Rejected or timed-out external action must produce the Onyx 403 outcome once, with no hidden retry; test in Task 3.
4. A Web App start repeated after success must reuse the managed process and return its real status/port; test in Task 4.
5. Empty, nested, binary, and Unicode Web App downloads must be valid ZIPs with the Onyx filename and MIME type; test in Task 5.

---

## File ownership and dependency map

| Task | Owner role | Depends on | Owned implementation files | Produces |
| --- | --- | --- | --- | --- |
| 1. Baseline/contract | researcher + reviewer (read-only) | — | `docs/plans/craft/port/` parity fixtures/report only | pinned Onyx SHA, contract matrix, executable fixture cases |
| 2. Managed content + prompt | backend_implementer | 1 | `server/src/craft/agent-instructions.ts`, `AGENTS.template.md`, `skills.ts`, `workspace.ts`, `manager.ts`, `routes.ts`, `server/src/index.ts`, focused tests | `resolveCraftManagedContent(userId, sessionId)` snapshot; rendered prompt and skill files |
| 3. MCP/connect_app/security | backend_implementer | 2 | `server/src/craft/opencode-config.ts`, new focused Craft MCP/approval modules, `server/src/craft/opencode/serve-client.ts`, agent-sandbox gateway/proxy changes as required, focused tests | session-tagged MCP config, connect_app tool, approval/403 event contract |
| 4. Web App tool/runtime | backend_implementer | 2 | new `server/src/craft/templates/webapp.plugin.ts`, `server/src/craft/workspace.ts`, `server/src/craft/nextjs-dev.ts`, relevant agent-sandbox dev-server endpoint, focused tests | `webapp(start/status/logs)` tool and managed `start-webapp.sh` |
| 5. Output contract | backend_implementer | 1 | `server/src/craft/webapp-proxy.ts`, `directory-archive.ts` if shared, focused tests | Onyx-compatible ZIP download |
| 6. Full parity verification | backend_validator + reviewer | 3, 4, 5 | reports under `docs/plans/craft/port/`; no business-code edits | behavior evidence, independent review, OCR report |

Task 3 and Task 4 share `workspace.ts` and the sandbox runtime: execute serially in one integration worktree. Task 5 may be prepared separately only if its file ownership and test resources stay isolated. The primary agent integrates and checks each reviewed checkpoint before releasing dependent tasks.

### Task 1: Pin the Onyx contract and resolve existing design conflict

**Interfaces:** Consumes Onyx Craft implementation and this review. Produces a versioned comparison fixture and source map for Tasks 2–6.

- [ ] Record `git rev-parse HEAD` for both repos, OpenBot BASE, dirty-file baseline, and Onyx source paths in `docs/plans/craft/port/` without copying secrets.
- [ ] Trace Onyx session creation → managed-content push → workspace setup → opencode config → prompt/tool call → event translation → output. Record exact tool schemas, prompt substitutions, MCP permission rules, webapp results, and ZIP HTTP contract with file/line references.
- [ ] Compare each previously declared intentional divergence in `docs/plans/craft/port/port-parity.md` against the user's parity requirement. Record a ruling: restore parity, environment-equivalent substitution, or explicitly blocked by missing OpenBot capability. A blocked item is not marked complete.
- [ ] Add fixture inputs/expected outputs for a bare user, a user with one connected and one connectable app, a disabled MCP tool, an approval denial, a Web App start, and archive download. No assertion may be derived solely from OpenBot's current behavior.
- [ ] Verify every acceptance row maps to one later Task and that the task dependency graph is acyclic.

### Task 2: Resolve managed content and render the original instructions

**Interfaces:** Consumes Task 1 fixtures. Produces `CraftManagedContent` containing `connectableAppsSection: string`, `skillFiles: ReadonlyMap<string, Uint8Array>`, `mcpServers: readonly CraftMCPServerConfig[]`, `skillsHash: string`, and `mcpConfigHash: string`. Resolve it for the authenticated user and session, not the deployment-wide Bot ID.

- [ ] Write failing tests that compare the rendered AGENTS.md with Onyx fixtures, including the connectable-app list, company-search guidance, no-app fallback, placeholders, and organization instructions. Remove tests that assert those sections stay cut.
- [ ] Write failing tests for managed-content hash changes and actual skill-file delivery to `.opencode/skills`; the current null-hash default must fail these tests.
- [ ] Implement the resolver using OpenBot's existing app/knowledge authorization sources. If no equivalent company-search source exists, create a scoped adapter contract and mark the feature blocked until a real backed implementation is wired; do not ship a prompt that promises a missing tool.
- [ ] Materialize managed content and user library in the session workspace with session ownership and path containment. Generate AGENTS.md only after resolution succeeds; make partial setup retryable.
- [ ] Wire `managedContentHashesFor` from the real resolver in `server/src/index.ts`; on changes, rewrite content/config, dispose the pinned OpenCode instance, then acknowledge the new hashes only after successful push.
- [ ] Run the focused prompt, skill, and reload tests. Expected: byte-level prompt assertions and changed-capability reload pass.

### Task 3: Restore MCP and connect_app behavior with approval boundaries

**Interfaces:** Consumes Task 2 `CraftManagedContent.mcpServers`. Produces a per-session OpenCode `mcp` block, tool permission rules, and `connect_app` result/announcement packets compatible with Onyx's observed wire fields.

- [ ] Write failing tests for remote MCP entries (`type`, `url`, `enabled`, `oauth`, session tag header), wildcard allow plus named disabled-tool deny, and `connect_app: ask`.
- [ ] Write failing integration tests for allowed, rejected, timed-out, and cross-user app access. Assert one approval attempt, audit record, 403 payload, no retry, and no credential bytes in workspace/config/event logs.
- [ ] Port the Onyx connect_app tool schema and permission handshake. Route calls through OpenBot's authorized connector/approval gateway; keep the app credential on the server or trusted proxy side.
- [ ] Pass the resolved MCP server list and session ID into `buildProviderOpencodeConfig`; ensure workspace creation and reconcile use identical snapshots. Remove comments that still label MCP as an empty future phase.
- [ ] Ensure OpenCode tool discovery and `connect_app_request` packet translation work in a real sandbox with a fixture MCP server. Verify a changed permission set disposes/recreates the OpenCode instance.
- [ ] Run focused tests and a sandbox session. Expected: Onyx-equivalent tool list and approval outcomes; deny paths never execute the external action.

### Task 4: Restore the Web App tool and managed startup

**Interfaces:** Consumes Task 2 workspace setup. Produces the Onyx `webapp` tool actions (`start`, `status`, `logs`) and a managed script/process/port for one interactive Craft session.

- [ ] Write failing tests against the Onyx tool schema and response strings for no app, first start, repeated start, logs, port conflict, and readiness failure.
- [ ] Port the protected `start-webapp.sh` generation from Onyx's session workspace path, including per-session port reservation and command restrictions; do not let the agent edit the script.
- [ ] Add the `webapp` plugin to the session plugin list and materialize its source before writing opencode.json. Reconcile must refresh it and dispose an old instance when tool configuration changes.
- [ ] Connect `webapp` actions to the existing Craft dev-server gateway. Preserve the one-process-per-session and ready/status semantics; align AGENTS.md's instructions with the actual tool and fallback script.
- [ ] Run focused tests and a real OpenCode session that asks for a Web App. Expected: tool is discoverable, `start` provisions once, `status` and preview route report the same port, repeated `start` is idempotent.

### Task 5: Restore the ZIP output contract

**Interfaces:** Consumes Task 1 ZIP fixtures. Produces `GET /api/craft/sessions/:id/webapp-download` as a ZIP response with Onyx's content type and session-derived `*-webapp.zip` filename.

- [ ] Write a failing route test that opens the returned bytes as ZIP and checks nested/binary/Unicode files, filename, `application/zip`, 404 ownership behavior, and empty directory behavior against Onyx.
- [ ] Replace `tarGzip(entries)` on this route with a ZIP writer. Reuse the repository's ZIP utility if one meets the fixture; otherwise add one bounded dependency and record it in the deployment dependency list.
- [ ] Keep tar.gz only on routes for which Task 1 confirms Onyx uses tar.gz. Update frontend consumers if they assume the old `webapp.tar.gz` name.
- [ ] Run the route tests and download/open an archive produced by the running server. Expected: standard ZIP reader accepts it and all entries match the workspace bytes.

### Task 6: Verify the complete call chain and review the full delivery

**Interfaces:** Consumes all reviewed checkpoints. Produces an evidence report, source-to-port mapping, configuration/dependency list, call-chain/state diagram, difference rulings, and final review results.

- [ ] Run targeted Craft tests, `bun run typecheck` in `server`, and applicable agent-sandbox checks; record exact commands, output, and checkpoint SHA/hash.
- [ ] Exercise an authenticated session from HTTP entry through workspace provisioning, prompt/tool discovery, OpenCode events, persisted message, SSE output, Web App preview, and ZIP download. Use controlled MCP/approval fixtures; compare observable packets and file bytes to Task 1.
- [ ] Have an independent reviewer issue separate Spec-compliance and code-quality conclusions for each task. Resolve all valid blocking findings through the owning task's SDD repair cycle.
- [ ] Run OCR with `--audience agent` on the entire delivery: BASE..HEAD for committed changes and workspace mode for every uncommitted/untracked delivery file. Save reports by round; incomplete coverage is failure.
- [ ] Recheck the complete scope after fixes. Completion requires no valid critical/high/medium findings, all mapped acceptance rows verified, and no unrelated dirty-file changes.
- [ ] Update the requested final deliverables from code evidence: feature mapping, full runnable TypeScript entry points, dependencies/config, entry-to-output state flow, and every remaining environment-driven difference. Do not label a deliberately missing capability as parity.

## Execution policy

Use one isolated execution worktree and SDD in dependency order. Before each implementation task, record HEAD and the tracked/untracked checkpoint. Since this plan does not grant commit authorization, implementers use uncommitted checkpoints unless the user separately authorizes commits. Preserve the existing unrelated OpenMuse spec edits. If a parity requirement conflicts with a still-binding approved ADR or cannot be provided by existing connector/knowledge infrastructure, record the precise conflict or blocker and finish the unaffected tasks; do not report full parity until resolved.
