# T04-R5-2-F2 Intrinsic accessors and file-content coverage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this scoped repair.

**Goal:** Prevent caller-defined property getters from executing during supported V1 binary/URL canonicalization, and verify the non-image file path in the pinned Mastra adapter.

**Architecture:** Capture the built-in `%TypedArray%.prototype` getters for `buffer`, `byteOffset`, and `byteLength`, plus `URL.prototype.href` getter. Use `Reflect.apply` on those trusted getters rather than ordinary property access. Incompatible receivers fail closed through the parser boundary. Keep the prior base64/href canonical forms, sparse-array early rejection, and general class-instance rejection unchanged.

**Sources:** R5-2/F1 review finding in `.superpowers/sdd/2026-10-11-mastra-ocr-r5-boundary-migration-fixes/reports/task-r5-2-f1-review.md`; approved Intelligence-only spec §§3–4; pinned Mastra `DataContent` and conversion APIs.

## Global Constraints

- Preserve the OpenBot/Mastra responsibility boundary and existing parser API/failure code.
- Preserve the 2-second child-bounded maximum sparse test and all prior hostile-input defenses.
- Recovery HEAD: `b1532dbe4ec4d2e64b58fd31c57a7c1863ffd155`. No commit, history rewrite, stash, push, merge, deployment, database, or edits outside owned files.
- No arbitrary size cap.

## Task DAG

| ID | Acceptance | Depends on | Owner | Validator | Owned files | Verification | Status |
|---|---|---|---|---|---|---|---|
| R5-2-F2 | Shadowing accessors on Uint8Array and URL are never invoked and cannot change true bytes/href; pinned Mastra `application/pdf` file conversion preserves binary and URL data; existing image, sparse-array and hostile-input protections pass | R5-2-F1 checkpoint | backend_implementer | backend_validator | `server/src/mastra/intelligence-contracts.ts`, `server/tests/enterprise/intelligence-contracts.test.ts` | targeted RED, contract + compatibility tests, strict tsc, Biome, diff check | pending |

## Steps

1. **RED:** Add tests defining an own `buffer` getter on valid `Uint8Array` and an own `href` getter on valid `URL`. Count invocations and require parsing to succeed, require each custom getter invocation count to remain zero, and require the canonical values to equal the intrinsic original bytes/href; current behavior should fail. For the typed-array case, use a sliced view and shadow all three `buffer`, `byteOffset`, and `byteLength` properties separately so every intrinsically read field is covered. Run only that test filter for a safe RED. Add `application/pdf` binary and URL file cases that traverse parser → pinned `convertMessages(...).to("Mastra.V2")` → `AIV4.Core`; assert actual Core `file` parts preserve base64 and URL. These cases should confirm the adapter path directly.
2. **GREEN:** Use captured native typed-array getters and URL href getter with `Reflect.apply`; do not read shadowable instance properties. Ensure getter extraction is fixed at module initialization and parser catches invalid receivers. Do not relax rejection of unrelated custom object prototypes.
3. Keep canonicalization and maximum sparse behavior intact. Rerun full focused contract and Mastra compatibility suites.
4. From `server/`, run `bunx tsc --noEmit --target ES2024 --module ESNext --moduleResolution bundler --strict --skipLibCheck src/mastra/intelligence-contracts.ts tests/enterprise/intelligence-contracts.test.ts`; `bunx biome check src/mastra/intelligence-contracts.ts tests/enterprise/intelligence-contracts.test.ts`; `git diff --check -- src/mastra/intelligence-contracts.ts tests/enterprise/intelligence-contracts.test.ts`.
5. Record exact task delta from F1 baseline and save after snapshots, hashes, patch, RED/GREEN report in the established R5 SDD directory.

**Failure handling:** If built-in getters cannot safely read an accepted form, fail closed and report the exact pinned runtime/type evidence. Do not call user-defined conversion hooks or broaden supported object prototypes.
