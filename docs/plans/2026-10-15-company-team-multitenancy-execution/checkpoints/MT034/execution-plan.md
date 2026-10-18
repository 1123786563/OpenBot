# MT034 execution plan (worker task_5ca25b872dec)

Ticket: Issue #77 共享账号审批绑定对象、参数摘要与归属 — tree w16-mt034, prereq manifest 284/284 verified.

## Steps
- [ ] 1. bun install; port 55593 preflight
- [ ] 2. container mt034-impl-pg (pgvector/pgvector:pg16 @127.0.0.1:55593); DBs openbot_enterprise_w16b_test + _assigned + openbot_kb_w16b_test (KB owner first, psql -c per item)
- [ ] 3. seven-var env /tmp/mt034-env.sh 0600
- [ ] 4. base migrate (enterprise-test-db.ts migrate) + restricted logins
- [ ] 5. prereq chain: MT004→MT008→MT112→MT012→MT014→MT010→MT009→MT077→MT026→MT076→MT069→MT016→MT041→MT027→MT028→MT070→MT031→MT042→MT059 → MT029→MT073→MT060 (three-step recipe per task, generate+dry-run+apply+manifest)
- [ ] 6. baseline: bun test tests/multitenancy/ --timeout 60000 (server/) → 1222/0/47
- [ ] 7. TDD RED: server/tests/multitenancy/shared-approvals.test.ts (missing module)
- [ ] 8. GREEN: db/schema/enterprise-shared-approvals.ts + enterprise/tenancy/shared-approvals.ts + support fixture + 4 seams (schema/index.ts barrel, migrate-test.ts MT034 task last, migration-tool.test.ts allowlist, src/index.ts assembly)
- [ ] 9. REFACTOR + focused suite green 0 skip
- [ ] 10. full regression = 1222+N, typecheck 0, biome touched 0
- [ ] 11. mutation: each safe branch ≥1 (inject→focused capture→byte restore→re-green) + MANIFEST
- [ ] 12. RESTORE bit-by-bit (before/after hashes, frozen surfaces)
- [ ] 13. checkpoints/MT034/ full set + reports/MT034.md
- [ ] 14. teardown: docker rm echo, env delete
- [ ] 15. worker_done (orca orchestration)

## AC mapping (Issue #77)
- AC1 approval valid only for locked object + params digest; param change → re-approval
- AC2 team switch → old approval not reused (dedicated test)
- AC3 cross-company requests & approvals always rejected
- AC4 revocation: pending requests not operable by that user; approved actions re-validated per MT029

## Disclosed seams (narrow, additive only)
- server/src/db/schema/index.ts (barrel +1 line)
- server/scripts/multitenancy/migrate-test.ts (append MT034 task, chain last)
- server/tests/multitenancy/migration-tool.test.ts (allowlist + "MT034", ruling #5 continuation)
- server/src/index.ts (assembly append)
