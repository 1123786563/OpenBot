# T02 Verification Repair 03 — Void Returning Button Ref Callback

- **Source:** final app typecheck isolated the remaining `TS2322` to a callback ref added by T02 in `app/tests/button-native.test.tsx:54`; the expression body returns the assigned node, while React ref callbacks must return void or a cleanup function.
- **Parent:** B1 Task 2 and final shared-layer verification requirement.
- **Goal:** preserve the ref assertion and make the test callback's return type valid.
- **Scope:** one test line in one T02-owned test path; no runtime code changes.
- **Owner/sequence:** one `mechanical_worker`, then independent validation/review. No commits.
- **PRE:** `docs/verification/workspace-redesign/execution/checkpoints/t02-r3/PRE/`.

## Owned path

| Path | Allowed change |
|---|---|
| `app/tests/button-native.test.tsx` | Replace the expression-bodied ref assignment with a block-bodied callback that assigns `receivedRef` and returns void. Keep the same assertion and rendered Button. |

## Verification

Run the focused native Button suite, changed-path Biome, `git diff --check`, app typecheck and build. Save exact POST source and PRE→POST patch. Do not alter any other existing test/type errors; report them if present.
