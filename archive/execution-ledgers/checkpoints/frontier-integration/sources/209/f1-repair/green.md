# F1 Repair — GREEN evidence

Fix applied (GREEN, minimal diff in `server/src/gateway/conversion-rate-store.ts`):

- New module-private `CONVERSION_RATE_SAVE_LOCK_KEY = "openbot:gateway:conversion-rate-save"`.
- `saveConversionRate`'s transaction now takes
  `select pg_advisory_xact_lock(hashtext(...))` as its **first statement**; the lock is
  transaction-scoped (released on commit/rollback), so the read → `previousVersion + 1` →
  upsert sequence is atomic across concurrent saves. Idiom identical to
  `server/src/memory/defaults.ts` (`pg_advisory_xact_lock(hashtext(key))`).
- No schema change, no migration, no change to `enterprise_settings` value shape, no
  change to any public signature; `pg_notify` contract untouched.

Verification (serial execution; concurrent `bun test` processes against the shared test
DB are not a supported mode — see report.md "Notes"):

```bash
TEST_DATABASE_URL=postgres://openbot:openbot@127.0.0.1:5569/openbot_test \
  bun test server/tests/gateway-conversion-rate.integration.test.ts
# → 13 pass / 0 fail (46 expect)  — includes the new concurrency test [44.93ms]
# → re-run after Biome format --write: 13 pass / 0 fail (stable)

bun test server/tests/gateway-conversion-rate.test.ts
# → 45 pass / 0 fail (136 expect)

# Flake check, concurrency test isolated, 3 consecutive serial runs:
# → 1 pass / 0 fail ×3

bun run --filter server typecheck
# → server typecheck: Exited with code 0

bunx biome lint --error-on-warnings \
  server/src/gateway/conversion-rate-store.ts \
  server/tests/gateway-conversion-rate.integration.test.ts
# → Checked 2 files. No fixes applied.

bunx biome check --error-on-warnings --formatter-enabled=true \
  server/src/gateway/conversion-rate-store.ts \
  server/tests/gateway-conversion-rate.integration.test.ts
# → Checked 2 files. No fixes applied.  (after one `biome check --write` pass)
```

Serial full-file stability after the fix: 6/6 consecutive runs 13 pass / 0 fail.
