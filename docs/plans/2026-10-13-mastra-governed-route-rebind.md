# Governed Model Route Rebinding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement the assigned Task. Steps use checkbox (`- [ ]`) syntax for tracking. The coordinator owns independent validation and Review.

**Goal:** Reconstruct a model route for an admitted Run from the verified persistent route reference and current deployment configuration, failing closed if any authority, model, credential, plan endpoint, or network destination has changed.

**Architecture:** The catalog already validates a stored `CanonicalModelRouteSnapshot`; a new helper asks the server configuration for the current route of the snapshot's agent, canonicalizes it using the catalog's existing function and the same secret, then requires an exact route reference match before returning the current runtime route. This compares all fingerprinted fields without duplicating private HMAC algorithms or storing plan tokens/provider secrets in the catalog.

**Tech Stack:** TypeScript, Bun, existing HMAC route catalog and synthetic DB-free catalog tests.

**Spec:** `docs/superpowers/specs/2026-10-11-mastra-intelligence-only-design.md`; parent T2 `docs/plans/2026-10-11-mastra-intelligence-only-dag.md`; accepted T2 production continuation `docs/plans/2026-10-12-mastra-t2-production-cutover.md`.

**Source evidence:** `.superpowers/sdd/2026-10-12-mastra-t2-production-cutover/reports/governed-success-route-architecture.md` (SHA256 `70091d421fa9c8151a0bbec9fb39c700d4376e83cdff8b3f115228e1698b3417`), §3. The approved `canonicalizeModelRouteSnapshot` computes the same versioned HMAC/fingerprint values used at admission; using it again avoids changing the independently reviewed catalog module.

## Global Constraints

- Route authority comes only from a server-admitted `routeRef`, the verified catalog row and current server/deployment configuration. Client `forwardedProps`, body model hints, headers and tenant selectors cannot choose a route or credential.
- A missing catalog row, agent mismatch, credential-reference change, provider/model drift, plan endpoint drift, or native base-URL drift must fail closed before any key resolution or network model request.
- The snapshot remains safe: no API key, plan token, plan endpoint URL, or native base URL is persisted or logged as a route snapshot.
- No schema/migration, catalog algorithm, provider transport, SSE Runner or agent execution edit in this task. This helper is independently reviewable before the later gateway wiring.
- Preserve the dirty worktree. No commit/stage/stash/reset/rebase/merge/push/PR/publish/worktree deletion or database service/use. Isolated PostgreSQL acceptance remains unverified.
- Freeze complete before/after content/hashes, full git-visible manifests, task-only patch and RED/GREEN output for the uncommitted Review Package.

## Review Focus

- A changed credential secret reference is refused before the credential reader is invoked; the focused test records zero reader calls.
- A plan route whose endpoint changes but whose provider/model stay the same is refused; the test checks the catalog's endpoint fingerprint binding.
- An OpenAI or Anthropic base URL change, including default-to-custom or custom-to-default, is refused; the test covers both providers and normalization.
- A forged agent ID or a row from another tenant cannot rebind; catalog scope and the callback agent ID are both checked.
- A model environment override applied after admission cannot select a different provider/model through the later gateway; the helper's drift test checks the recomputed route, and the gateway composition must strip `BOT_MODEL`/`BOT_PROVIDER` after rebinding.

---

### Task 1: Rebind a canonical route to current server configuration

**Dependency:** Reviewed DB-free T2-SSE checkpoint (validator SHA256 `193681c325af511a12f262fa0b08d218222b60919ecb2e47442ea4e40e33b91d`; reviewer SHA256 `d9d942794fa633be1f01ffc5b05d130a978c872062943661308f70d1c064390a`). The success-terminalization task may run before or after this task; they own disjoint source files. The actual model executor consumes both only after both independent gates pass.

**Owner role:** backend_implementer. **Validator:** backend_validator. **Reviewer:** independent reviewer.

**Files:**

- Create: `server/src/enterprise/runs/model-route-rebind.ts` — pure server-side binding helper with a catalog read.
- Create: `server/tests/enterprise/model-route-rebind.test.ts` — DB-free fake catalog and canonicalization/drift tests.
- Protected, read-only: `server/src/enterprise/runs/model-route-catalog.ts`, `server/src/enterprise/models/runtime-adapter.ts`, `server/src/copilot.ts`, and the existing catalog tests. No edit without a new reviewed plan.

**Consumes:** `ModelRouteCatalogStore.get(scope, routeRef): Promise<CanonicalModelRouteSnapshot | null>`, `canonicalizeModelRouteSnapshot(scope.tenantId, ModelRouteSnapshotInput, secret)`, `ModelRouteSnapshotInput`, `PlatformScope`, `RuntimeModelRoute`.

**Produces:**

```ts
export async function rebindModelRoute(input: {
  scope: PlatformScope;
  routeRef: string;
  catalog: Pick<ModelRouteCatalogStore, "get">;
  currentRouteForAgent: (agentId: string) => Promise<ModelRouteSnapshotInput | null>;
  modelCapabilitySecret: string | Uint8Array;
}): Promise<RuntimeModelRoute | null>;
```

`null` means the catalog row or current server route is unavailable; `MODEL_ROUTE_DRIFT` means the current route's canonical reference differs. The current route callback is server-owned and must return the same agent ID requested by the helper; mismatch throws `MODEL_ROUTE_AGENT_MISMATCH`. The later gateway's `selectModel` callback maps `null` or a drift error to a fail-closed unavailable response and never falls back to a client model or a different route. No token/key is returned from the persistent snapshot; the returned runtime route contains only the current server-selected values.

- [ ] **Step 1 — Preflight and RED tests.** Record HEAD, full manifest, protected catalog/runtime-adapter/copilot hashes and exact source-map file versions. Add tests for matching native route, matching plan route, missing row, missing current route, callback-agent mismatch, different tenant/ref, provider/model/credential drift, plan endpoint drift, plan absence, and native base URL drift for both providers including normalized Anthropic `/v1`. Use `canonicalizeModelRouteSnapshot` to seed a verified fake catalog return; no database or credential reader. The new module is absent before implementation.
- [ ] **Step 2 — Run RED.** From `server/`, run `bun test tests/enterprise/model-route-rebind.test.ts`; expected nonzero exit because the rebind module/function does not exist. Save full output and exit code; do not weaken assertions.
- [ ] **Step 3 — Implement the helper.** Assert trusted scope and nonempty `routeRef`; ask `catalog.get(scope, routeRef)`, return `null` on absence. Call `currentRouteForAgent(snapshot.agentId)` exactly once, return `null` on absence; require its `agentId` equals the snapshot's. Recompute `canonicalizeModelRouteSnapshot(scope.tenantId, currentInput, modelCapabilitySecret)` and require its `routeRef`, `agentId` and canonical snapshot equal the stored row; otherwise throw `MODEL_ROUTE_DRIFT`. Return `currentInput.route` only after this equality. Propagate catalog corruption and invalid-current-route errors as refusal; do not catch them into a permissive route. Do not copy HMAC/fingerprint logic from the catalog.
- [ ] **Step 4 — GREEN and protected checks.** Run `bun test tests/enterprise/model-route-rebind.test.ts tests/enterprise/model-route-catalog.test.ts tests/enterprise/ai-sdk-v3-gateway-adapter.test.ts` from `server/`; expected all pass. Run `bunx biome check` on the two new files and `git diff --check` on their task patch; expected clean. Use TypeScript check and report the known unrelated `scripts/enterprise-runtime-probe.ts:63` diagnostic if it remains, with no new diagnostic in owned files. No DB integration.
- [ ] **Step 5 — Freeze and hand off.** Save exact new file contents/hashes, `/dev/null`→new-file patch, full before/after manifests, protected hash comparison, RED/GREEN/static logs and report under `.superpowers/sdd/2026-10-13-mastra-governed-route-rebind/`. Report exact refusal codes and the later gateway's need to strip `BOT_MODEL`/`BOT_PROVIDER` from its environment after current route selection. The coordinator dispatches independent backend validation and Spec/quality Review at the same hashes.

**Acceptance:** Rebinding returns only the exact current server route matching a validated persistent route reference; any listed drift refuses before credential resolution; all DB-free tests and independent gates pass. No gateway/model execution is enabled yet, and isolated database validation remains unverified.

## Shared-file and interface preflight

| Boundary | Owner | Consumer | Guard |
| --- | --- | --- | --- |
| `model-route-catalog.ts` HMAC/canonicalization | Prior reviewed Fix2, read-only here | New rebind helper | Existing catalog hash `ca0050ceb582766167dc7329776906a46de96a2d46c0b41f763792771ced4dee` unchanged |
| `model-route-rebind.ts` | This task | Later T2-GOV gateway composition | Stable `rebindModelRoute` signature and independent Review before consumption |
| `contracts.ts` / `service.ts` / `store.ts` | Governed success task, serial workspace | Later executor | No edit here; no shared writer |
| `index.ts` / `copilot.ts` / `runner.ts` | Reviewed SSE now; later executor task | This helper indirectly | No edit here; later production composition binds server-selected route and strips post-rebind overrides |

Self-review: Every Review Focus input has a named RED case and the green suite; no persistent secret is introduced. This independently testable helper closes route reconstruction without touching the protected catalog implementation, while the gateway/executor integration remains a separate task.
