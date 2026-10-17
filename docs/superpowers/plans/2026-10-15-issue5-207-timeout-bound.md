# Issue #207 Request Timeout Bound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject gateway request timeouts that cannot fit the database `integer` column so invalid values return an explainable validation error rather than a database 500.

**Architecture:** Keep one shared pure validator in `server/src/gateway/endpoint.ts` for both administrator writes and deployment environment parsing. Align the accepted upper bound to PostgreSQL `int4` (`2_147_483_647`) so all accepted values are persistable without adding an unsupported operational policy.

**Tech Stack:** TypeScript, Bun tests, PostgreSQL test database, Drizzle/Postgres, Biome.

**Spec:** Parent [Issue #5 Bifrost Spec](../../specs/2026-10-14-bifrost-github-spec.md); Ticket #207 snapshot and reviewer finding in the sibling checkpoint `docs/execution-ledgers/checkpoints/207/review.md`; existing #207 plan in `docs/superpowers/plans/2026-10-15-issue5-bifrost-strict-credit-integration.md`.

## Global Constraints

- Do not enable any gateway/model path; #207 only supplies validated configuration.
- Reject invalid timeout values consistently at environment parsing and admin-write validation; accepted values must fit `gateway_configs.request_timeout_ms` PostgreSQL `integer`.
- Do not modify the issue5-207 user-owned worktree; transfer its exact checkpoint into a fresh Orca child worktree and verify hashes before repair.
- Use only the dedicated `openbot_207` test database at `localhost:5432`; never touch development or production data.
- No commit, push, merge, deployment, release, or migration change.

## Review Focus

- Maximum representable timeout (`2_147_483_647`) must be accepted, while one greater must be rejected before database access.
- Admin PUT above the limit must return 400 with a useful validation reason, leave the stored row/version unchanged, and never become a database 500.
- Environment startup parsing must reject the same out-of-range value through the same shared validation rule.
- Ordinary positive timeout values and prior URL validation behavior must remain unchanged.
- Timeout zero, negative, fractional, non-numeric, and unsafe-integer inputs must remain rejected.

---

### Task 1: Import and verify the reviewed checkpoint

**Files:**
- Transfer from sibling `issue5-207` to this repair child worktree only the 12 deliverable files listed in its `file-hashes.txt` plus checkpoint report and hash ledger.
- Create `docs/execution-ledgers/checkpoints/207/f1-repair/{plan.md,red.md,green.md,report.md}` in the repair worktree.

**Interfaces:**
- Consumes: original checkpoint at BASE `f0520524f0faa2b4533b9d2f1aa692c8f907ba71`; reviewer report finding F1.
- Produces: byte-identical copy of all source checkpoint files, with full SHA-256 source/target equality before edits.

- [ ] Record source and target HEAD, tracked diff, and source file list.
- [ ] Copy only the declared checkpoint files and verify full SHA-256 equality against the source worktree before changing code.
- [ ] Save the result as the repair plan and ensure the review report's F1 is preserved verbatim in the repair report.

### Task 2: Reject timeout overflow

**Files:**
- Modify `server/src/gateway/endpoint.ts`.
- Test `server/tests/gateway-endpoint-config.test.ts`.
- Test `server/tests/gateway-endpoint-config.integration.test.ts`.
- Modify `server/src/config.ts` only if the shared validator is not already used by the environment path; preserve #209's disjoint conversion-rate block.

**Interfaces:**
- Consumes: existing `parseRequestTimeoutMs` and `parseGatewayEndpointInput` APIs.
- Produces: the same public APIs with a maximum accepted value of `2_147_483_647`; out-of-range input returns the existing typed/reasoned validation failure.

- [ ] Add RED unit assertions: maximum int4 is accepted; `2_147_483_648` is rejected with a deterministic reason; retain invalid zero/negative/fractional/non-numeric cases.
- [ ] Add RED environment-path assertion for `GATEWAY_REQUEST_TIMEOUT_MS=2147483648` to reject at startup.
- [ ] Add RED integration assertion that admin PUT above the limit returns 400 with the validation reason and does not alter the persisted endpoint or `configVersion`.
- [ ] Run those tests against dedicated `openbot_207` and record the expected failing result.
- [ ] Implement the shared upper-bound validation using the int4 maximum; keep the public error response explanatory and avoid database exceptions.
- [ ] Run unit and integration tests serially against dedicated `openbot_207`, then server typecheck and Biome lint/format.

### Task 3: Checkpoint and independent review

**Files:**
- Create `docs/execution-ledgers/checkpoints/207/f1-repair/{red.md,green.md,report.md}`.

**Interfaces:**
- Consumes: repaired endpoint parser and test results.
- Produces: exact uncommitted snapshot identity, full SHA-256 manifest, test evidence, and remaining limitations for a fresh independent reviewer.

- [ ] Verify no staged changes, no commit, and no files outside the declared checkpoint plus three repair files.
- [ ] Record complete staged/unstaged diff, all task-scoped untracked contents/hashes, and actual check exit codes.
- [ ] Pause implementation and let a separate Pi reviewer inspect the same final snapshot before this Ticket is marked verified.

## Review Focus Resolution

Each Review Focus item maps to Task 2 tests above: integer boundary, admin 400/no-write behavior, env parity, ordinary positive path preservation, and malformed numeric values. No database schema change or producer/gateway activation is needed.
