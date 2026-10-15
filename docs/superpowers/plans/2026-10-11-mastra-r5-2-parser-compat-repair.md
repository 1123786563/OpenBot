# T04-R5-2-F1 Mastra message compatibility and sparse-array repair

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement the repair task-by-task. Keep the implementation scoped to the approved files.

**Goal:** Close the two verified Medium findings in R5-2 review while preserving the hostile-input boundary: support legal Mastra V1 binary/URL file parts and reject enormous sparse arrays without work proportional to their declared length.

**Architecture:** Keep a persistence-safe detached representation. Canonicalize accepted `Uint8Array`/`Buffer`/`ArrayBuffer` data to base64 strings (the pinned Mastra/AI SDK string data form), canonicalize accepted `URL` values to detached `.href` strings, and reject all other class instances. Before enumerating array indexes, compare the number of own keys with `length + 1`; only then iterate present indices. Continue validating from cloned data and catching hostile reflection failures as `invalid-input`.

**Sources:** Approved Intelligence-only design §3; R5 Task 2; verified findings in `reports/task-r5-2-review.md`; pinned Mastra types in `server/node_modules/@mastra/core/src/_types/ai-sdk.types.d.ts`.

## Global Constraints

- Preserve OpenBot authorization/execution/Run/budget ownership and the public parser signature/error behavior.
- Keep existing R5-2 verified protections and do not weaken hostile reflection tests.
- Preserve recovery HEAD `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`; no commits, reset, amend, rebase, stash, push, merge, deployment, or external/shared DB.
- Only edit `server/src/mastra/intelligence-contracts.ts` and `server/tests/enterprise/intelligence-contracts.test.ts`.
- No arbitrary payload cap or new user policy.

## Task DAG and Acceptance

| ID | Acceptance | Depends on | Owner | Validator | Owned files | Verification | Status |
|---|---|---|---|---|---|---|---|
| R5-2-F1 | Legal Mastra V1 binary and URL file parts are losslessly canonicalized into detached persistence-safe data; large sparse arrays return `invalid-input` promptly without length-proportional allocation; prior R5-2 security tests and compatibility remain green | R5-2 implementation + independent review findings | backend_implementer | backend_validator | `server/src/mastra/intelligence-contracts.ts`, `server/tests/enterprise/intelligence-contracts.test.ts` | focused contract + compatibility, targeted strict tsc, Biome, diff check; tests for each typed representation, byte fidelity/input mutation, and large sparse length | pending |

## Steps

1. **RED:** First add legal V1 image/file tests for `Uint8Array`, a sliced `Buffer`, `ArrayBuffer`, and mutable `URL`. Assert that each parse succeeds, that binary content round-trips byte-for-byte and URLs retain their `.href`, and that mutating source bytes or the source URL after parse does not alter detached content. Pass each parser result through the pinned Mastra adapter: `convertMessages(parsed).to("Mastra.V2")`, then back to the real V1/UI or Core conversion and compare attachment bytes/URL identity. Import the actual adapter from `@mastra/core/agent`. Run these safe regression cases against the current implementation and record expected `invalid-input` failures. Do **not** invoke a maximum-length sparse array against the vulnerable implementation; the source-level defect is proven by the existing `for (index < length)` loop preceding the own-key cardinality comparison, which would iterate billions of times.
2. **GREEN:** In the persistence clone, explicitly recognize supported byte buffers and URL objects before plain-object rejection. Convert bytes to base64 string and URLs to href strings; do not retain caller-owned mutable references. In arrays, compare own key count to declared length plus the `length` key before any index iteration or Set construction; then validate exact own numeric indices and descriptors. Preserve catch-and-fail-closed behavior.
3. Only after the early array guard is implemented, add a maximum sparse-array regression executed in a Bun child process with a 2-second parent timeout and forced child termination on timeout. Assert the child exits successfully after promptly returning `{ok:false, invalid-input}`. This bounds resources if the regression returns.
4. Run `bun test tests/enterprise/intelligence-contracts.test.ts` and `bun test tests/enterprise/mastra-compatibility.test.ts` from `server/`.
5. Run from `server/`: `bunx tsc --noEmit --target ES2024 --module ESNext --moduleResolution bundler --strict --skipLibCheck src/mastra/intelligence-contracts.ts tests/enterprise/intelligence-contracts.test.ts`; `bunx biome check src/mastra/intelligence-contracts.ts tests/enterprise/intelligence-contracts.test.ts`; and `git diff --check -- src/mastra/intelligence-contracts.ts tests/enterprise/intelligence-contracts.test.ts`.
6. Save exact before/after snapshots, hashes and scoped patch. Report compatibility encoding choices and command output.

**Failure handling:** If pinned Mastra code indicates a different accepted byte/string representation, verify against the installed declarations and data conversion implementation before selecting canonical form. Preserve unknown class-instance rejection. Do not change the broader message schema or add arbitrary caps.
