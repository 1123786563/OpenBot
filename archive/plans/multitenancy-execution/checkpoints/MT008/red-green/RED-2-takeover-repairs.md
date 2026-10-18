# RED-TAKEOVER (3rd takeover, ctx_3e5857d058e2, 2026-10-16)

## As-found state

The 2nd takeover left the implementation and the full 29-test suite on disk but
the suite did NOT pass as found. First honest run of
`bun test tests/multitenancy/resource-policy.test.ts --timeout 30000` (all five
env vars set) returned:

```
3 tests failed:
(fail) ... criterion 1 > suspended team members lose the team-public path but keep grant-based reads (existing behavior preserved) [18.56ms]
(fail) ... criterion 4 > workspace-v1 denies cross-company facts even with a grant and workspace visibility (policy level) [1.87ms]
(fail) ... criterion 4 > tenancy-v1 denies the same cross-company facts (unchanged) [0.11ms]

 26 pass
 3 fail
 155 expect() calls
```

## Diagnosis (evidence)

1. **Criterion-4 policy-level tests (2 failures).** The shared helper
   `factsOf` spread the WHOLE overrides object into the resource literal
   (`...overrides` inside `resource: {...}`), so a nested
   `resource: { tenantId: "tenant-b" }` override landed as an inert nested
   key and `resource.tenantId` stayed `"tenant-a"`. Both policy versions then
   correctly ALLOWED, and the tests failed expecting DENY. The production
   decision code was right; the test helper was broken. Assertion output
   showed `Expected deny/RESOURCE_NOT_FOUND, Received allow`.
2. **Criterion-1 suspended-member test (1 failure).** Re-run with `-t "suspended team members"`
   produced:
   ```
   error: WORKSPACE_FORBIDDEN
       at .../server/src/enterprise/tenancy/store.ts:161:21
   ```
   The MT005 seam (`createScopeResolver`) refuses to issue a scope to a
   suspended member, so `fixture.scopeFor(...)` AFTER suspending throws
   before any decide() assertion runs. The test as written demanded a scope
   the seam will never issue.

## Repair (test-only; no production code changed)

1. `factsOf` now destructures nested keys
   (`{ scope, grant, workspaceMembership, ...resourceOverrides }`) so flat
   resource-field overrides and scope/grant/membership overrides compose
   correctly; the four call sites that passed nested `resource: {...}`
   objects now pass flat overrides (`tenantId: "tenant-b"`,
   `workspaceId: "workspace-a2"`).
2. The suspended-member test now issues the scope BEFORE suspending (a
   legitimately issued, then stale scope) and asserts decide() re-checks
   CURRENT membership facts under RLS: fresh scope resolution is refused with
   WORKSPACE_FORBIDDEN (seam behavior pinned), the stale scope loses the
   team-public path, keeps the explicit-grant path, and the restored member
   is allowed again.

Both repairs make the tests exercise the intended acceptance facts through
paths the production seams actually support; no assertion was weakened and no
production semantics changed. GREEN evidence: red-green/GREEN-1-full-suite.txt
(29 pass / 0 fail).
