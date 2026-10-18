# G04 checkpoint — Refresh an expired Google grant (issue #29 / ticket G04)

Executed `docs/superpowers/plans/tickets/G04-refresh-grant.md` (openmuse worktree) EXACTLY with full
TDD: RED (7-test G04 matrix, suite failed on the missing seams) → GREEN → this checkpoint. No commits;
prior uncommitted checkpoints untouched.

## Vendor error-shape definition (fake contract, recorded for O02)

- **Expired-credential class** (Task 0): a provider action answered **HTTP 401** with body
  `{success:false, error:{code:"token_expired", message}}` — the answer shape OpenConnector's
  docs/credentials.md publishes (`answerOf` in `plugins/openconnector-adapter.ts` reads
  `message`/`error.message`/`success:false`). `client.ts` classifies on the **401 alone**
  (`OpenConnectorAuthExpiredError extends OpenConnectorOAuthError`); the nested `code` string is the
  documented placeholder — live value verified at O02.
- **Action-call seam**: `POST /v1/actions/<actionId>` body `{input}` + `x-oo-connector-alias` header,
  the generic seam the adapter models (`openconnector-adapter.ts` `execute`, ~line 349).
- **Refresh action id**: PLACEHOLDER `gmail.refresh` / `googlecalendar.refresh` (M01 discipline,
  `openMuseRefreshActionId(provider)` in google-oauth.ts) — live ids verified at O02.

## Behavior (matrix, all green)

1. provider call → vendor 401 flips the row `refresh_required` (+ sanitized lastError); later calls
   refuse 409 `OpenMuseRefreshRequiredError` (subclass of `OpenMuseConnectionRefusedError`, so
   concurrent M04/A02 `instanceof` catches keep working) with ZERO further dials (fake dial count asserted);
2. `POST /api/mobile/openmuse-google/:provider/refresh` success → `connected`, provider calls resume,
   generation UNCHANGED for the same identity;
3. identity change (refreshed profile's accountEmail differs) → generation 2, row accountEmail updated,
   connectedAt advanced; `requireConnection` exposes `{status:"connected", generation:2}` so R03+ can
   bind and refuse generation-1 proposals as stale;
4. refresh failure → 502 rethrown, row stays `refresh_required`, `lastError` = FIXED sanitized sentence
   `OpenMUSE_REFRESH_FAILED_MESSAGE` (vendor message that quoted `refresh_token=…` never persisted);
   retryable (retry dials again);
5. refresh on a disconnected/revoked row → 409 "Connect X before using it.";
6. foreign owner → 404 (`OpenMuseConnectionMissingError` — no row of theirs, no leak); §9 disabled
   owner → 403; unknown provider → 404, no dial;
7. status routes expose `{status, generation, lastError?}` — `lastError` key present only when set
   (single-provider and combined listings).

New seams: `runProviderCall` (guard-first provider-call fence; catches the auth-expired class),
`refresh`, `overwriteConnection` row-seam method (writes the row EXACTLY as computed — no generation
bump; `saveConnection`'s reconnect bump unchanged), `client.callAction`.

## Migration SQL (verbatim, `drizzle/0088_glossy_gideon.sql`; generated, NOT applied — no db:migrate)

```sql
ALTER TABLE "openmuse_google_connections" ADD COLUMN "last_error" text;
```

Journal `idx 88` + `meta/0088_snapshot.json` written by `drizzle-kit generate`. The one-column change
required touching `src/db/schema/openmuse.ts` (the `lastError` column) — the only owned-file deviation
beyond openmuse-connectors/* + its test, inherent to "migration ONLY if needed".

## Files + shasum

```
96f7c4ebebd1984c6e646559cd941f32289f2dc6  server/src/openmuse-connectors/client.ts
9cf82b9de81e722525d1247d40378acee0e77211  server/src/openmuse-connectors/google-oauth.ts
2b5f9a1048957e920a8bb70229fc71f0312def04  server/src/openmuse-connectors/store.ts
5d4a0ded0a1ba43a56acf10026843fbecc2956ee  server/src/openmuse-connectors/routes.ts
d9c1192e75762f4158c51dc2446b2635ea8fae33  server/src/db/schema/openmuse.ts
9cad5695ca376899d278cd9fde702ad286cdec19  server/tests/openmuse-google-oauth.test.ts
e6085ba573610f0e8b721c434aa24c5b0e74defd  server/drizzle/0088_glossy_gideon.sql
```

## Verification tails

- `bun test tests/openmuse-google-oauth.test.ts tests/ready.test.ts` → **42 pass / 0 fail / 256 expect**
  (39 in the oauth suite incl. the 7 new G04 tests + 12 pre-existing matrix kept green; 3 ready).
- `tsc --noEmit` (bun run build) → clean, zero output.
- `biome check` on the 6 owned files → "No fixes applied" clean after `--write` (formatting only).

## Deferred

S16 live-token refresh evidence against a real OpenConnector + Google deployment is gate-level and NOT
claimed here: the vendor 401/error-code shape, the real refresh action ids, and refresh token lifetime
are recorded placeholders for O02. R03+ Reviewed-action generation binding consumes
`requireConnection`'s generation as-is; M04/A02 may adopt `runProviderCall` for their dials (their
modules untouched).
