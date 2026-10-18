# Frontier Integration — Independent Review (read-only Pi reviewer)

- **Reviewer**: independent Orca Pi reviewer Dispatch (task `task_68b8d1bfb21a` / ctx `ctx_0ee385bc724a`); neither the integrator (Task `task_25ef8e77f9a7`) nor any source-ticket implementer/reviewer. Review started 2026-10-15 ~18:57 CST, after the integration Task settled.
- **Object under review**: the exact settled uncommitted checkpoint of `/Users/wuyongjun/orca/workspaces/OpenBot/issue5-frontier-integration`, branch `1123786563/issue5-frontier-integration`, **HEAD `f0520524f0faa2b4533b9d2f1aa692c8f907ba71` (== BASE)**, staged diff **empty**, bound to `final-state/manifest.md` (2026-10-15T09:22:46Z) and its 39-entry SHA-256 table.
- **Review mode**: read-only on the delivery (this file is the only write); no commit/stage/push; all DB work on dedicated test DBs only, serial; no gateway enabling; no production/dev DB contact; source worktrees only read (`shasum`/`diff`/`git` reads — final status comparison confirms untouched).

## Verdict

| Dimension | Verdict |
| --- | --- |
| **Spec compliance** | **PASS** — plan Task 1 observable acceptance fully met; all four tickets' reviewed contracts transferred and preserved; migration/snapshot invariants hold; #215 F1 and #207 F2/newline resolved; no-commit scope exact. |
| **Code quality** | **APPROVE** — no Critical/High findings; one Medium **evidence-integrity** finding (M1: `final-state/manifest.md` is stale for `verification.md` by the integrator's own post-manifest §8 append) plus Low/Info items, none requiring code change. |

## 1. Checkpoint identity, hash binding, and stability

- `git rev-parse HEAD` = `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`; `git diff --cached` empty (0 lines) — matches manifest §git identity.
- `git status --porcelain -uall` recomputed and diffed against the manifest's recorded 64-entry listing: **byte-identical** (6 modified tracked + 58 untracked, including every ledger doc; nothing extra, nothing missing). No commit was made at any point.
- All **39** manifest SHA-256 entries recomputed with `shasum -a 256`:
  - **38/39 match exactly** — every one of the 31 delivered production/test/migration/meta server files, the plan copy (`0234ed9f…`), and 6 of 7 ledger docs.
  - **1/39 mismatch — `verification.md`**: manifest records `678b5c68…`, on-disk is `095ad5cb…`. Forensics: `verification.md` mtime **18:56:09**, i.e. ~94 min **after** the manifest snapshot (17:22:46); it is the **only** file in the repo newer than the manifest; the added content is §8 "Final on-disk rerun (post-ledger, before worker_done)" — the integrator's own disclosed final battery append. It was **not modified during this review**: `095ad5cb…` at my first hash (~18:58) and unchanged at final re-check; git scope and the other 38 hashes re-verified stable at review end. See finding **M1**.
- Plan-copy claim cross-checked: `0234ed9f…` == parent plan in `issue5-execution` (hash-verified during transfer audit; matches manifest).

## 2. Transfer integrity vs read-only source worktrees (25 deliverables)

All five source worktrees confirmed at HEAD `f0520524…` on their branches. For **every** transferred deliverable I recomputed `shasum -a 256` at **source and child** and compared to `transfer.md`'s table: **25/25 equal** (`endpoint/config-store/routes/schema-gateway/SQL/0122-snapshot/2 test files` from `issue5-207-timeout`; `conversion-rate/conversion-rate-store/2 tests` from `issue5-209`; `payer-ref/payer-account/schema-payer/payer SQL→0123/2 tests` from `issue5-215` — SQL content byte-identical, rename only; `schema-bots/service-registry/admin-routes/bot SQL→0124/bot test/app.ts/audit.ts` from `issue5-234`).

Additional transfer-audit claims independently reproduced:

- #207's 5 non-repair deliverables byte-identical across `issue5-207` and `issue5-207-timeout` (5/5 recomputed) — "authoritative = timeout worktree, rest identical" holds.
- Shared-merge input hashes at sources match `transfer.md` exactly: #207 `config.ts` `3d3bd74c…`; #209 `config.ts` `5b28118a…`; #215 `index.ts 642981b1…` / `drizzle.config.ts 623fe383…` / journal `5229afd6…`; #234 `index.ts 82a8125f…` / `drizzle.config.ts 0f4168e4…` / journal `1808e3df…` / `0122_snapshot.json 1ef71dd4…`.
- Source-journal tails confirm the three-way idx-122 collision premise: #207 `when 1792039004488`, #215 `1792039063976`, #234 `1792036800000` (all `idx 122`).
- `issue5-215` really lacks `0122_snapshot.json` (meta ends at 0121) — #215 review F1 premise confirmed.
- **All 24 `sources/` copies** (`207/` incl. `f1-repair/`, `209/` incl. `f1-repair/`, `215/`, `234/`) byte-compared (`cmp`) against the source worktrees' checkpoint docs: **24/24 verbatim**.
- Source worktree `git status` shapes unchanged from review start to end (12/11/5/10/11 entries; nothing staged anywhere) — sources untouched by integration and by this review.

## 3. Shared-file merges

- `config.ts` 3-way merge — **zero contract loss proven independently**: `diff` #207-source→child = **0 deletions**, additions are exactly #209's `bifrostConversionRate` block (+import, +type field, +`gatewayConversionRate`, +wiring); `diff` #209-source→child = **0 deletions**, additions are exactly #207's `gatewayEnvConfig` block. Both reviewed contracts survive verbatim; final hash `862310a5…` == manifest.
- `schema/index.ts`: diff vs BASE is exactly `+export * from "./bots"`, `"./gateway"`, `"./payer"` at alphabetical anchors — matches each ticket's line verbatim.
- `drizzle.config.ts`: exactly +3 schema paths at each ticket's anchor (gateway after `delivery.ts`, bots after second `billing.ts`, payer after `payment.ts`).
- `app.ts` / `audit.ts` (#234 whole-file): diff vs BASE **pure additive** (+24 import/optional-param/conditional-mount; +9 audit union `bot_service.registered/edited/status_changed`), no existing logic touched.

## 4. Migrations, journal, snapshot chain

- **SQL filenames** `0122_gateway_endpoint_config.sql` / `0123_payer_accounts.sql` / `0124_bot_services.sql` exist; content byte-identical to reviewed sources (#215/#234 renames only).
- **Journal**: diff vs BASE **pure addition** (+21 lines, three entries after 0121; every historical entry byte-untouched); 125 entries, idx contiguous 0–124; `when` **strictly increasing across all 125** (tail: `1792039004488 < 1792039063976 < 1792039063977`); tags ↔ file names agree; `version:"7"`/`breakpoints:true` consistent; **terminal newline `0x0a` present, matching BASE** — #207 review F2 (newline) resolved. #234's `when` bump to `…977` (= #215's +1) is the documented minimal monotonic choice.
- **Snapshot chain 0121→0124** (programmatic, on delivered files):
  - `prevId` continuity: 0122→0121 (`fbb4e855…`), 0123→0122 (`533380cc…`), 0124→0123 (`cd8dfb17…`); 4 unique ids.
  - Table counts 160→161→162→163; each step adds **exactly one** subtree (`public.gateway_configs` / `public.payer_accounts` / `public.bot_services`), removes none, changes none.
  - **All** 0121 and 0122 subtrees deep-equal preserved through 0124 (no historical tree rewritten); 0123's payer subtree preserved in 0124; 0124's `bot_services` subtree **deep-equal to #234's reviewed subtree**, id preserved (`efa2f5db…`).
  - `git status` on `drizzle/meta/`: only `_journal.json` modified + 3 **new** snapshots untracked — **no historical snapshot file touched**; pre-existing 0054/0055 and 0086/0096 collisions retained (rationale documented, §4 of adjudication).
  - **#215 review F1 (missing payer snapshot) is closed**: `0123_snapshot.json` exists, correctly sequenced, subtree drizzle-authored (sandbox provenance per adjudication §3; the sandbox re-derived #207's and #234's subtrees deep-equal — independent validation of both hand-built snapshots).
- **`drizzle-kit check --config=drizzle.config.ts`**: exit 0, output = only the two documented historical collision notes (0054/0055, 0086/0096) — identical to clean-HEAD behavior; zero complaints about the new chain.

## 5. Dispatch focus areas (code-level, integrated child)

| Focus | Result | Evidence |
| --- | --- | --- |
| #207 timeout int4 repair | **Present** | `endpoint.ts:48` `REQUEST_TIMEOUT_MS_MAX = 2_147_483_647` (single source of truth) + rejection sentence at :22/:60; `config.ts:1525` delegates to `parseRequestTimeoutMs`, throws shared-sentence error (`GATEWAY_REQUEST_TIMEOUT_MS: …`). Fresh-DB `\d gateway_configs`: `request_timeout_ms integer NOT NULL DEFAULT 10000` (int4). |
| #209 rateVersion concurrency repair | **Present** | `conversion-rate-store.ts:69` `pg_advisory_xact_lock(hashtext(CONVERSION_RATE_SAVE_LOCK_KEY))` is the transaction's **first** statement, before the read; `rateVersion = previousVersion + 1` inside the critical section; concurrency test green (13/0 incl. the competing-saves case). |
| Payer identity, no fallback | **Present** | `payer-ref.ts`: 4 kinds; prefix-encoded keys (`payer-personal-`/`payer-company-`/delegated `openbot-deployment-`); `unknown_owner` throws `PayerOwnerUnknownError` at derivation **and** before lookup ("有行也拒"). `payer-account.ts`: `PayerAccountMissingError` — "no payer account is registered … there is no fallback"; no fallback/default-payer code paths (grep). |
| BotService inert permissions | **Present** | `service-registry.ts` writes only `botServices` (insert + 2 updates); no credentials/credit/billing writes; `app.ts` mount comment states "Registration grants no credentials and no credit authority"; integration tests assert zero side effects (7/0). |
| Shared config/schema registrations | **Verified** | §3 above. |
| Gateway not enabled | **Verified** | `createGatewayConfigRoutes`/`readGatewayEndpoint`/`GATEWAY_CONFIG_TOPIC`/`config.gateway` referenced **only** inside `src/gateway/` + its 2 tests (grep across `src/`); `bifrostConversionRate`/`readConversionRate` zero consumers outside gateway+config; no routes mounting in `app.ts`. |
| `/api/admin/bots` mount | **Conditional** | `app.ts:1018` mounts only when `botServiceDatabase` present (absent-means-unmounted, same contract as billing); guards inside factory (`requireUser` + `requireAdmin`). |

## 6. Independent runtime verification (all serial; dedicated DBs only)

Unit (no DB): `gateway-endpoint-config.test.ts` **16/0/45**; `gateway-conversion-rate.test.ts` **45/0/136**; `payer-ref.test.ts` **9/0/24**.
Integration (explicit `TEST_DATABASE_URL`): #207 on `openbot_207` **9/0/33**; #209 on `127.0.0.1:5569/openbot_test` (incl. concurrency case) **13/0/46**; #215 on `openbot_frontier_215` **9/0/32**; #234 on `openbot_frontier_234` **7/0/36**.
→ **108 tests / 0 fail; every count equals the checkpoint's GREEN and its source checkpoint parity.** The `tests/support/database.ts` guard requires an explicit `TEST_DATABASE_URL` and cannot fall back to the dev DB.

Regressions (documented baselines reproduced exactly): `config.test.ts` **140/1** (failure = "enables Google authentication…" — documented pre-existing BASE failure, failure name confirmed); `audit.test.ts` on `openbot_frontier_234` **7/1** (failure = "declares nothing this deployment cannot write", the documented workshop.* pre-existing); `admin-people-credentials-validation` + `agent-routes` **64/0**.

Static: `bun run typecheck` (server) → `tsc --noEmit` **exit 0**; `bunx biome lint --error-on-warnings <24 changed files>` → **1 warning only**: `app.ts:1011 noUnusedFunctionParameters` — reproduced on clean HEAD at line 1003 (`git show HEAD:server/src/app.ts` linted: same warning), i.e. pre-existing, line-shifted by #234's additive wiring. Formatter drift: biome format diffs on /tmp copies — child `config.ts` drift lines = **subset of the union** of #207-source and #209-source drift lines (**zero merge-introduced drift**; child 80 vs sources 76+76 with overlapping lines, child-only lines: none).

**Independent from-scratch migration apply (documented per dispatch)**: created fresh dedicated DB **`openbot_frontier_review`** (`DROP IF EXISTS` + `CREATE` on container `openbot-postgres-1`), then `DATABASE_URL=postgres://openbot:openbot@localhost:5432/openbot_frontier_review bun scripts/migrate.ts` → `{"type":"migrations-applied","status":"ok"}`; `drizzle.__drizzle_migrations` = **125 rows**; last three `hash` values (by id) = **SHA-256 of the three delivered SQL files** (`e452ae4f…`, `b3913af4…`, `90bb0b59…`) with `created_at` carrying the journal `when`s; structures verified: `gateway_configs` (PK id, int4 timeout default 10000), `payer_accounts` (PK id; `payer_accounts_owner_unique_idx` UNIQUE(kind,owner_id); `payer_accounts_external_customer_unique_idx` UNIQUE(external_customer_id); CHECK kind 4 values; FK→billing_customers(external_id) ON DELETE CASCADE), `bot_services` (PK bot_id, jsonb capabilities, status default 'active'). The DB is left in place as review evidence (no business data).

## 7. Findings

| # | Severity | Finding | Evidence / disposition |
| --- | --- | --- | --- |
| **M1** | **Medium** (evidence integrity; no code impact) | **`final-state/manifest.md` is stale for exactly one file**: it binds `verification.md` at `678b5c68…`, but the integrator appended §8 (final on-disk rerun) at 18:56:09 — 94 min after the manifest snapshot (17:22:46) — leaving on-disk `095ad5cb…`. The checkpoint's own integrity manifest therefore does not fully bind its final state. Mitigations: only file newer than the manifest; the append is self-disclosed ("post-ledger, before worker_done"); every one of the 31 deliverables and the other 6 ledger docs match the manifest; the §8 claims were independently re-verified true by this review (108/0, typecheck 0, HEAD/scope unchanged); no change occurred during the review window (first and final hashes identical). | **Recommended follow-up**: integrator refreshes the manifest's `verification.md` hash line (or appends a dated addendum) before this manifest is used as the canonical reference. Not blocking either verdict. |
| L1 | Low | Plan Task-1 step 6 says "verify … **124 total migrations**"; delivery = **125 journal entries** (idx 0–124, i.e. through migration #124). The numbering/diff/invariants are correct and internally consistent; the plan's count wording is off by the BASE count (122 pre-existing + 3 new = 125). | Wording-level; no action needed beyond awareness (or a plan errata note). |
| L2 | Low (inherited, documented) | Repo-level `drizzle-kit generate` remains unusable on HEAD (historical snapshot collisions + snapshot/code divergence). Correctly left unrepaired (out of write scope); a dedicated repair ticket is still required before the next **generated** migration. | Adjudication §3; reproduced by integrator in disposable copy; `drizzle-kit check` exit 0 confirms runtime chain health. |
| L3 | Low (inherited, documented) | Pre-existing failures reproduced identically: `config.test.ts` Google-auth 140/1; `audit.test.ts` workshop.* 7/1; `app.ts` `noUnusedFunctionParameters` warning (HEAD:1003 → child:1011). | All three proven pre-existing on clean HEAD; not introduced or shifted in substance by this integration. |
| I1 | Info | The 24 `sources/` checkpoint-doc copies are verbatim (all 24 byte-compared) but are **not** hash-bound in `final-state/manifest.md` (they appear only in its git-status listing). | Consider including them in the refreshed manifest (pairs with M1). |
| I2 | Info | Reviewer-created dedicated test DB `openbot_frontier_review` (125 migrations applied, no business data) left in place as evidence. | Documented here per dispatch ("no cleanup beyond dedicated test data"). |
| I3 | Info (inherited, open) | Source-review open items deliberately **not** absorbed by this integration, as recorded: #209 F2/F3/F4/N1/N2 (→ #210), #215 F2 (SQLSTATE matching) / F3 (credits-writer flake) / F6 (CONTEXT.md glossary entries for PayerRef), #234 L1 (JSON parse 400) / L2 (capabilities dedupe), #207 N1 (int4-max HTTP PUT hardening); `.env.example` unchanged (#209's recorded deviation); gateway routes mounting remains with 01.2. | Correct scope discipline; successor tickets should pick these up. |

Resolved-by-this-integration confirmations: #207 F2 (journal terminal newline) ✓; #207 F5 / #215 F7 (three-way idx-122 collision) ✓; #215 F1 (payer snapshot) ✓.

## 8. Limitations

1. RED evidence (5 failing suites pre-merge + 2 documented expected-passes) was **not** re-executed — reproducing it would require reverting the settled checkpoint (violates read-only). Internal consistency checked (failure reasons match missing-merge/missing-migration premises); source-checkpoint RED pointers exist under `sources/`.
2. The merge-seam incident (first post-merge unit run failed on a dropped `}`; fixed; GREEN numbers are final reruns) is disclosed in `green.md`/`verification.md`; not independently reproducible post-fix — accepted on disclosure since all final numbers were re-verified by this review.
3. Full 8058-test regression suite not rerun (matching both the source checkpoints' and the integration's documented stance); the three documented regression baselines were rerun and match exactly.
4. `drizzle-kit generate` sandbox provenance of the 0123 payer subtree/id was accepted on the adjudication's recorded evidence (sandbox no longer exists); validated indirectly: chain invariants, deep-equal re-derivations of #207/#234 subtrees recorded, and the from-scratch apply on a fresh DB matches the delivered SQL hashes and structures.
5. Timezone note: ledger `final-state` timestamp is UTC (09:22:46Z) vs local mtimes (CST +8, 17:22:46) — consistent; the 18:56:09 §8 append is likewise local time.

## 9. Closing

The integrated checkpoint is exactly the union of the four accepted reviews: 25/25 deliverables hash-verified at source and child, shared merges proven lossless, migrations serialized correctly with a continuous, history-preserving snapshot chain, the two carried findings (#215 F1, #207 F2) closed, all 108 ticket tests green with source-parity counts, static checks clean at documented baselines, and the no-commit scope intact and stable throughout this review. **Spec compliance: PASS. Code quality: APPROVE** — with M1 (stale manifest hash for `verification.md`) flagged for a one-line manifest refresh before the manifest is treated as canonical.

— Recorded 2026-10-15 ~19:1x CST by the independent reviewer; commands and outputs as cited per section above.
