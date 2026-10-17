# MT008 mutation checks (≥3 required by brief; 4 mutants run)

Target: MT008-authored production code (resource-policy.ts, resource-visibility.ts).
Method: hand-applied source mutation -> focused bun test -t run -> record kill/survive
-> restore original -> verify green. Env: the five MT008 env vars (no skips).

| Mutant | Mutation | Result |
|---|---|---|
| MUT1 | workspace-v1 membership-status check → `if (false)` | KILLED (criterion 1 suspended-member test) |
| MUT2 | tenancy-v1 grant check → `if (false)` | KILLED (criterion 2 authz-parity test) |
| MUT3a | migration UPDATE isNull guard dropped | SURVIVED (judge-guard redundancy) |
| MUT3b | MUT3a + judge guard removed | KILLED (criterion 3 private-never-widened test) |
| MUT4 | workspace-v1 cross-tenant defense removed | KILLED (criterion 4 policy-level test) |

No production mutation survives in the final tree; MUT3a survivor is disclosed as a
redundant-defense observation (the SQL guard is not independently pinned by a test,
the judge guard is; both removed = killed).
