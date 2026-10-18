# RED → GREEN evidence (MT026)

## RED-1 — migration registry (6th precedent)
Command: `bun --no-env-file test tests/multitenancy/migration-tool.test.ts`
Assertion appended FIRST (allowlist += "MT026"); registry had no MT026 yet.

```
(fail) issue #46 criterion 3: deterministic names and increasing numbers > the allowlist is exactly the registry and the shipped self-check task [0.21ms]
 40 pass
 1 fail
```
Failure reason: expected allowlist contains "MT026", actual registry does not —
the feature (task registration) was missing. Correct RED.

## GREEN-1 — registry appended
Same command after appending SSO_SCIM_ISOLATION_TASK + TASKS entry:

```
 42 pass
 1 skip
 0 fail
```

## RED-2 — domain modules (new files, TDD)
Command: `bun --no-env-file test tests/multitenancy/sso-scim-config.test.ts tests/multitenancy/scim-directory.test.ts tests/multitenancy/identity-binding.test.ts`
Tests + support fixture written FIRST; production modules absent:

```
error: Cannot find module '../../../src/enterprise/tenancy/sso-scim-config' from '.../support/sso-scim.ts'
 0 pass
 3 fail
 3 errors
```
Failure reason: the MT026 modules do not exist (feature missing). Correct RED.

## GREEN-2 — after implementing schema + 3 modules
See 01-new-suite-final.txt (final focused run) — appended after implementation.
