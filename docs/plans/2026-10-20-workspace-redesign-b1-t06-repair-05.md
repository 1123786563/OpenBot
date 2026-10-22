# T06 Review Repair 05 — Use Typed Exports Route Parameters in the Direct Guard Test

- **Source:** app-wide typecheck reports `tests/observability-route-guards.test.tsx` using a concrete Bot ID where TanStack requires the parameterized route pattern; the route ID assertion also assumes a route type not represented by the reduced in-memory tree.
- **Parent:** T06-R1 direct route guard coverage, followed by T06-R4 typecheck verification.
- **Goal:** keep the production exports `beforeLoad` route test type-safe while preserving allow/deny behavior assertions.
- **Scope:** one T06-owned test path only; no production behavior changes.
- **Owner/sequence:** one serial `frontend_implementer`, then focused validator/reviewer. No commit.
- **PRE:** `docs/verification/workspace-redesign/execution/checkpoints/t06-r5/PRE/`.

## Owned path

| Path | Allowed change |
|---|---|
| `app/tests/observability-route-guards.test.tsx` | Navigate using the typed `/bots/$agentId/exports` route with `{ agentId: "bot-1" }`; assert the allow path URL and that an active match exists, while retaining denied guard rejection. Remove only the invalid concrete-path/route-ID typing assumption. |

## Verification

Run that test natively and through its ADR 0008 driven `app/tests/ai-observability` group, changed-path Biome, `git diff --check`, and full app typecheck. Any remaining errors must be independently established as outside this scope. Capture PRE/POST bytes and delta. Browser permission acceptance remains deferred.
