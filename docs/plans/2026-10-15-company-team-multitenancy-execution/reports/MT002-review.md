# MT002 Independent Review — Issue #45 / DAG node MT002

- Reviewer task: `task_256795d6159d` / Dispatch `ctx_a30408950bd3` — independent of implementation Task `task_fbc7b14de451` / Dispatch `ctx_97107555809d` and credential-redaction repair Task `task_a67106001ae6` / Dispatch `ctx_50bb55b845f0`.
- Review date: 2026-10-15 (UTC). Review is **read-only**; the only write by this reviewer is this file. No tests re-executed, no database mutations, no commits/push/merge/deploy/migrations.
- Reviewed package: `review-packages/MT002.json`, declared `package_sha256 = 23e451200a7c5647a639d77b94da291cbce002a9f08355da706f8a6bdb38ca5a` — **verified** (see §1).
- Snapshot scope: findings apply to the frozen snapshot (code worktree `i6-mt002` @ `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`, untracked `server/tests/multitenancy/` only) and the checkpoint artifacts under `checkpoints/MT002/`. No secret values are quoted anywhere in this report; credential scans report counts and paths/line numbers only.

## Verdicts

| Verdict | Result |
| --- | --- |
| **Spec compliance (Issue #45, 4 acceptance criteria + §11 identity matrix + A6)** | **PASS — 4/4 acceptance criteria satisfied with in-suite evidence** |
| **Code quality** | **PASS — real restricted-role/RLS harness, injection-safe query seam, disciplined cleanup; 1 Low + 5 Info findings, none blocking** |

## 1. Package integrity and frozen-snapshot verification

| Check | Result |
| --- | --- |
| `package_sha256` recomputed over the package JSON with `package_sha256` removed, canonicalized as compact JSON with sorted keys (`json.dumps(d, sort_keys=True, separators=(',',':'))`) | ✅ `23e45120…8ca5a` — exact match |
| All 14 per-file SHA-256 entries in `files{}` re-hashed (9 checkpoint artifacts, 1 report, 3 worktree sources, incl. empty `staged-and-unstaged.diff` = `e3b0c442…b855`) | ✅ 14/14 match |
| `after-manifest-sha256.txt`: all 12 listed checkpoint files re-hashed | ✅ 12/12 match |
| Checkpoint directory contains no file absent from `after-manifest-sha256.txt` | ✅ no unlisted files |
| Code worktree `i6-mt002`: HEAD = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` (== parent BASE, no commits made), branch `1123786563/i6-mt002`, `git status --porcelain` = single line `?? server/tests/multitenancy/`; that untracked dir contains **exactly** the 3 frozen files | ✅ no unlisted changes |
| Worktree source hashes == `manifest-sha256.txt` == `files/` snapshots == review package | ✅ `fixture.ts f1112f0f…a88c`, `scenarios.ts cdca14cc…bd0`, `fixtures.test.ts 667dd64e…c43` |
| Frozen-ownership tracked file `server/tests/support/enterprise-database.ts` consumed unmodified: working copy == HEAD, SHA-256 `d9e652799493f1492c86949db3c636b055305c7aec947da7b30185d9a8e49077` | ✅ matches `after.json` claim |
| Coordination chain: `MT002-task-receipt.json` (task brief == Issue #45 body verbatim, frozen ownership == the 4 files, sanctioned DB URL == the one used) and `MT002-redaction-dispatch.json` (docs-only repair scope) | ✅ consistent |

## 2. Acceptance-criteria evaluation (Issue #45)

### AC1 — 夹具覆盖 Spec §11 最低身份矩阵全部 8 类，并可按公司/团队/成员状态组合 → **PASS**

Spec §11 (docs/specs/2026-10-14-company-team-multitenancy-design.md, lines 224–226) requires 公司 A 团队甲/乙、公司 B 团队丙 plus 仅属甲、仅属乙、甲乙双成员、同团队另一人、跨公司用户、公司管理员、平台操作身份、受限 Worker 身份.

- `fixture.ts` `SPEC_IDENTITY_MATRIX` maps **all 8 classes** to 9 identities (`a1-member`, `a2-member`, `a1a2-member`, `a1-other`, `b1-member`, `multi-company`, `company-admin`, `platform-operator`, `worker`); the `FixtureIdentity` union is byte-for-byte the frozen `interfaces.md` T01 union. ✅
- Test “fixture covers every Spec §11 minimum identity matrix class” asserts every class has ≥1 representative, then verifies per-identity company/team facts (companies, team workspace ids, admin-with-no-teams, machine-identities-with-no-membership) against `HUMAN_PLAN`; facts are re-read from live `enterprise_memberships` rows under the directory role in “identity facts come from real database rows” — not from the plan object. ✅
- Positive isolation cases: 7×200 reads (own team resource per member, `a1a2-member` and `multi-company` across both their teams/companies). Negative cases: cross-company both directions → 403 `TENANT_FORBIDDEN`; cross-team, wrong-workspace-selector, same-team-other-person's resource, company-admin content read → 404 `RESOURCE_NOT_FOUND` (invisible, no existence leak — body carries error code only); machine identities → 401 `AUTH_REQUIRED`; unknown route/method → 404. ✅
- Company/team/membership-status combination: “suspending one company leaves the other intact” — real `suspendMembership` (epoch bump + audit event) on company A: A read 403, B read 200, DB rows verified `{status:"suspended", epoch:2}` in A vs `{status:"active", epoch:1}` in B. ✅

### AC2 — 专用测试数据库与受限业务角色；缺 TEST_DATABASE_URL 报错不回退 → **PASS**

- Reported environment (`checkpoints/MT002/environment.md`): dedicated ephemeral container `openbot-issue6-tenancy-test-pg` @ `127.0.0.1:55432`, database `openbot_enterprise_issue6_test`, matching the coordinator task brief's sanctioned URL — **not** the development `DATABASE_URL`. Three restricted LOGIN roles `ent_mt002_{directory,data,operator}`, each holding exactly one NOLOGIN capability (`ob_ent_directory/data/operator`), provisioned by the existing tooling (`enterprise-test-db.ts migrate`). ✅
- Fail-closed source verification (read of the frozen `server/tests/support/enterprise-database.ts` + `fixture.ts`): `enterpriseTestDatabaseUrlFrom` reads only `ENTERPRISE_TEST_SETUP_DATABASE_URL`/`TEST_DATABASE_URL`; `validateEnterpriseUrl` enforces loopback host (`127.0.0.1`/`localhost`/`[::1]`), `postgres(ql)` protocol, and database name matching `^openbot_enterprise_`; role URLs must name the **same instance+database** as the setup URL and get `-c role=<capability>` pinned; **no code path reads `DATABASE_URL`** (grep across both files: the only `DATABASE_URL` occurrences are the refusal tests). Refusal errors sanitize credentials out of the message. ✅
- In-suite refusal tests (4 variants): missing var → `/TEST_DATABASE_URL/`; `DATABASE_URL` present (dev-shaped `openbot:openbot@…/openbot`, a refused negative-control constant at `fixtures.test.ts:49`) → still `/TEST_DATABASE_URL/`; live DB name via `TEST_DATABASE_URL` (line 57 constant) → `/openbot_enterprise_/`; missing role logins → `/ENTERPRISE_TEST_DIRECTORY_DATABASE_URL/`. ✅
- Restricted-role reality: `openVerified` runs the real `verifyDirectoryDatabase`/`verifyDataDatabase`/`verifyOperatorDatabase` (`src/enterprise/tenancy/connections.ts`), whose catalog check enforces NOLOGIN capability attributes, login membership in exactly one capability, no escalation memberships, no ownership/ACL privileges on `enterprise_*` relations; test asserts `current_user = ob_ent_<role>`, `session_user ≠ current_user`, and unknown roles refused. ✅

### AC3 — 事务提交/回滚后上下文清除；同一连接复用不携带范围（专门测试） → **PASS**

- Implementation: per-role pools deliberately `max: 1` (`openVerified`), context set **transaction-locally** via `set_config('app.*', value, true)`; nothing session-level is ever written, so commit and rollback both clear it.
- Dedicated commit-side test proves reuse first — `pg_backend_pid()` identical across two consecutive context-scoped transactions — then asserts `app.tenant_id`/`app.principal_id`/`app.workspace_id` all unset and **0 visible rows** in `enterprise_resources` on the next transaction over the same backend. ✅
- Dedicated rollback-side test forces `1/0` abort with a live scope in place, then re-checks both properties. ✅
- RLS backing verified against real BASE migrations (`drizzle/0056_enterprise_tenancy_rls.sql`): all `enterprise_*` policies key on `nullif(current_setting('app.*', true), '')`; “data-role business transactions are tenant-scoped by RLS” additionally proves positive-scope/cross-tenant/no-context visibility (A sees only its 3 rows, B only its 1, no context → 0), and the worker test proves the RESTRICTIVE `enterprise_grant_self_read` policy closes principal-scoped tables to principal-less machine contexts (3 visible resources, 0 grants). ✅ (A6 posture)

### AC4 — 真实业务 factory 建数据，不用模拟授权器 → **PASS**

- All data via the real `provisionDeployment` (`src/enterprise/tenancy/provision.ts`, 3 idempotent operations) and real `suspendMembership`; the test verifies the three `deployment.provisioned` security events **under the operator role with operation-scoped context** (matching the real `enterprise_security_event_tenant_scope` policy requiring `id = app.operation_id`), that an unscoped operator enumerates nothing, and that grants are real rows read under data RLS. ✅
- `requestAs` runs the real authorization chain: session seam → real `createScopeResolver` (membership status/epoch checks under directory role, `src/enterprise/tenancy/store.ts:82`) → real `createResourceReader` (epoch re-validation `SCOPE_REVOKED`, grant join `RESOURCE_NOT_FOUND`, real `createAuthz()` from `src/enterprise/authz/service.ts`). The only injected seams are the session `authenticate` callback and header selectors — request-identity injection, **not** authorization mocking. No mocks anywhere in the three files. ✅
- Error semantics match frozen `interfaces.md` T01/T02 (401/400/403/404/503, code-only bodies, unknown faults collapse to `INTERNAL_ERROR` so internals can't leak).

## 3. Cleanup-leaves-fixture-rows-empty verification

- `cleanupFixtureRows` deletes by the fixture's unique `mt002-<domain>-<uuid8>` prefix across `enterprise_security_events`, `enterprise_resource_grants`, `enterprise_resources`, `enterprise_workspaces`, `enterprise_memberships`, `enterprise_principals`, `enterprise_tenants`, `users` — I cross-checked this against every write site in `provision.ts` (writes exactly the 6 enterprise tables) and the fixture's own inserts (`users`, `enterprise_principals`): **coverage is complete**, child-first order, and scoped so nothing outside the fixture can be touched. Failed creation also cleans up rows and connections; `dispose` is idempotent and refuses further use (both asserted in-suite). ✅ statically
- Gap (Low-1): the suite itself never asserts physical emptiness after `dispose` — the “dispose cleans up fixture rows” test asserts refusal + idempotency only, and the “zero `mt002-%` rows behind” evidence in report §4 is the implementer's manual post-run DB check, not reproducible from the frozen transcript. The static coverage analysis above supports the claim; see Findings.

## 4. Verification command, transcript, and 0-skips check

- Reported command (`environment.md`, post-redaction form): `source <env above> && bun test server/tests/multitenancy/fixtures.test.ts` — exactly Issue #45's verification command, run at the worktree root against `TEST_DATABASE_URL = postgres://postgres@127.0.0.1:55432/openbot_enterprise_issue6_test` plus the three restricted role logins. **Confirmed dedicated-test-DB / restricted-roles**, never the dev DB. ✅
- Transcript (`verification-output.txt`, hash-verified): **17 pass / 0 fail / 146 expect() / 0 skipped**; bun prints skip lines separately and none appear; the test file contains no `skip`/`todo`/conditional-skip constructs, and misconfiguration fails loudly rather than skipping (AC2 refusal tests). ✅
- This reviewer did **not** re-execute the suite: the review mandate is read-only, the ephemeral credentials were (correctly) redacted, and re-running would require re-provisioning the container (a DB mutation). Reproduction steps are fully retained in `environment.md`.

## 5. Credential-redaction repair verification (task_a67106001ae6 / ctx_50bb55b845f0)

| Claim in `after.json` / report §7 | Independent check | Result |
| --- | --- | --- |
| Literal restricted-LOGIN passwords removed from `environment.md`; placeholders `${ENT_MT002_*_PASSWORD}` + re-supply instructions; DB name/host, login names, capability names, env-var names, reproduction steps retained | Read of redacted `environment.md`; URL-embedded-literal-password scan (`://user:<literal>@`, `${VAR}` excluded) over all checkpoint root artifacts: **0 matches**; role-pattern scan (`ent_mt002_<role>:<literal>@`) across the **entire** plan directory incl. `files/` snapshots and `review-packages/`: **0 matches** | ✅ |
| `/tmp/mt002-env.sh` removed | Filesystem check: does not exist | ✅ consistent |
| Executable files byte-identical (repair was docs-only) | The 3 source hashes in the live worktree == original `manifest-sha256.txt` == `files/` snapshots == review package; `enterprise-database.ts` == HEAD | ✅ |
| Manifest consistency | `after-manifest-sha256.txt` 12/12 hashes verified, no unlisted checkpoint files; `before.json` preserved (hash matches both package and after-manifest listings) | ✅ |
| Honest disclosure of residual locations | Exactly 2 residual `user:password` URLs exist anywhere in the checkpoint tree: `files/fixtures.test.ts:49` and `:57` — both dev-shaped `openbot:openbot@127.0.0.1:5432/openbot` **negative-control inputs** that the AC2 refusal tests prove the fixture rejects; they are not restricted-role credentials and intentionally remained byte-identical | ✅ correctly classified |

## 6. Findings

| # | Severity | Finding | Citation |
| --- | --- | --- | --- |
| 1 | **Low** | Post-`dispose` physical emptiness is not asserted in-suite (dispose test checks refusal/idempotency only); the “zero rows behind” evidence is the implementer's manual post-run DB check. Static analysis shows `cleanupFixtureRows` covers every table the fixture/factory writes, so the risk is evidentiary, not a known leak. Suggest a downstream emptiness assertion (e.g. count-by-prefix via a second fixture or a pre-dispose assertion) when MT004/MT005 extend the fixture. | `fixtures.test.ts` “dispose cleans up fixture rows and refuses further use”; `fixture.ts` `cleanupFixtureRows`; report §4 |
| 2 | Info | Hardcoded dev-shaped negative-control URLs `openbot:openbot@127.0.0.1:5432/openbot` at `fixtures.test.ts:49,57`. Both are refused-input constants (proven by tests); acceptable while guaranteed dev-shaped, already flagged for code-phase follow-up if a real credential ever matches this shape. | `fixtures.test.ts:49,57`; `after.json` `findings_before`; report §7 |
| 3 | Info | Documented additive deviation from frozen `interfaces.md` T01: `RestrictedQueryContext.operationId?` (required by the operator role's operation-scoped RLS), plus additive members `domain`, `idPrefix`, `identities`, `restrictedRoles`, `suspendCompanyMembership`, and `externalEffects()` narrowed from `unknown[]` to `FixtureExternalEffect[]` (compatible refinement). Disclosed in report §5; the coordinator should fold this into the next `interfaces.md` revision so the frozen contract and code don't drift. | `fixture.ts` `RestrictedQueryContext`, `IsolationFixture`; `interfaces.md` T01 |
| 4 | Info | `parameterized()` reserves `$1..$n` placeholder syntax; a literal `$<digits>` inside SQL string constants or dollar-quote tags would be misparsed as a bind (out-of-range/unused-bind guards make it a loud error, not silent corruption). Test-support seam only; documented in-code. | `fixture.ts` `parameterized` |
| 5 | Info | Team membership is a fixture fact materialized via per-team resource grants until MT004 lands real membership rows; `identities[*].companies[*].teams` must be re-pointed to real rows in MT004/MT005. Explicitly disclosed in the fixture header and report §6.1 — a coordination item, not a defect. | `fixture.ts` header + `HUMAN_PLAN`; report §6.1 |
| 6 | Info | Supplementary report claims not independently re-verified (no frozen evidence, read-only mandate): “`enterprise-test-database.test.ts` still 12/12”, biome/format/tsc cleanliness, and repeated-run row-zero checks. This reviewer did independently re-run a read-only `biome check server/tests/multitenancy/` → clean (3 files, no fixes), consistent with the claim. | report §4 |

## 7. Constraints honored by this review

Read-only throughout: no business-code edits, no commits/push/merge/deploy/migrations, no DB connections or mutations, no secret values reproduced (scans report counts/paths/lines only), single write = this file. All conclusions are scoped to the frozen package/snapshot identified in the header.
