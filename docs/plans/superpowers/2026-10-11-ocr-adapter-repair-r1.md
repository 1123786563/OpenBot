# OCR Adapter Repair A-R1: Assert unknown providers fail closed

**Goal:** Close the low review finding by covering the explicit unsupported-provider failure with a test-only malformed route. Runtime behavior is already correct.

**Source:** `.superpowers/sdd/2026-10-11-ocr-adapter-url-repair/reports/review.md` SHA256 `6530c219421c746a3b6e4234352ada7c692e4c144c33473cad05cbe4c7a8d979`; baseline current HEAD recorded in before snapshot.

## Global Constraints

- Test-only edit to `server/tests/enterprise/mastra-model.integration.test.ts`.
- Do not widen RuntimeModel's closed provider union or change production code.
- Synthetic keys and local code path only; no DB/provider network, commit/stash/reset.

## Review Focus

Unknown provider passed through a narrow type cast throws `UNSUPPORTED_MODEL_PROVIDER` synchronously before any network dispatch.

## Task 1: Add fail-closed provider regression

**Role:** mechanical_worker → backend_validator → reviewer. **Owned file:** integration test only.

- [ ] **RED:** Add a focused test-only malformed route using `as never`; expect `createNativeModel` to reject unknown provider and confirm no local request was observed. Run it against the current implementation and record the expected pass as characterization (production already implements behavior); no artificial production failure.
- [ ] **Verify:** Run exact integration test and targeted Biome.
- [ ] **Checkpoint:** Full one-file after snapshot and increment with implementation report; independent checks inspect same bytes.

**Acceptance:** The existing explicit failure branch has a durable regression assertion; no production behavior changes.

## Interface consistency

| Provider union | Test cast | Expected behavior |
|---|---|---|
| closed `openai | anthropic` | deliberate malformed value | explicit generic unsupported-provider exception |
