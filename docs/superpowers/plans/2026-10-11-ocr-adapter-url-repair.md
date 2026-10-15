# OCR repair A: Normalize Anthropic base URL and reject unsupported providers

**Goal:** Correct the reviewed native Anthropic endpoint behavior for injected environments and make the closed provider union fail explicitly if it later expands.

**Sources:** OCR full workspace report `.superpowers/sdd/2026-10-10-mastra-intelligence-migration/reports/ocr-final-workspace.txt`; approved migration spec §6; existing `normalizeModelBaseUrls()` in `server/src/copilot.ts`; baseline `e15cef8ec3c3c223aaf0935a0ea81f8c5e370737`.

## Global Constraints

- Only edit `server/src/enterprise/models/runtime-adapter.ts` and `server/tests/enterprise/mastra-model.integration.test.ts`.
- Anthropic base URL passed to its SDK must end in one version segment (`/v1` by default) whether environment is injected or process-wide; do not double append or strip an explicit `/vN`.
- Keep OpenAI base URL behavior unchanged.
- Explicitly handle `openai` and `anthropic`; unknown future provider values fail closed.
- Synthetic loopback only. No real credentials/provider, DB, package changes, commit/stash/reset, or unrelated edits.

## Review Focus

1. Injected Anthropic base `http://127.0.0.1:<port>` requests `/v1/messages`.
2. Injected base ending `/v1/` normalizes to `/v1/messages`, no duplicate version or slash.
3. OpenAI route continues using its exact configured base URL.
4. Unknown provider reaches explicit unsupported-provider failure rather than Anthropic fallback.

## Task 1: Route-safe native provider construction

**Roles:** backend_implementer → backend_validator → reviewer. **Owned files:** runtime-adapter.ts and its synthetic integration test only.

- [ ] **RED:** Update the existing loopback integration to assert the Anthropic URL includes `/v1/messages` when the injected base has no version segment; add explicit `/v1/` no-double test (can be second Anthropic request) and assert OpenAI behavior unchanged. Add explicit default/provider branch test or a narrow type-safe unsupported-route test demonstrating unknown values do not fall through to Anthropic.
- [ ] **Implement:** Normalize Anthropic base by trim/trailing-slash removal and append `/v1` unless it already ends `/v<number>`. Use explicit `if provider === anthropic` and throw generic unsupported-provider error afterward.
- [ ] **Verify:** Run exact `mastra-model.integration.test.ts`; owned Biome; focused model/integration/gateway suite and affected typecheck. Record results.
- [ ] **Checkpoint:** Verify assigned before snapshot SHA `13f31b97abdce08b5c3eb849b6091f33f1f96031bf6b5dea2970601a38162f9b`; produce full after snapshot and increment package, report exact TDD and checks.

**Acceptance:** injected env endpoint always honors the documented Anthropic Messages base path while avoiding silent misrouting; future union members fail visibly.

## Interface consistency scan

| Consumer | Input | Output |
|---|---|---|
| `createRuntimeModelAdapter.createNativeModel` | locked provider + deployment base | matching provider SDK + canonical provider base |
| loopback test | unversioned/versioned synthetic endpoint | observed `/v1/messages` |

No dependencies or cycles.
