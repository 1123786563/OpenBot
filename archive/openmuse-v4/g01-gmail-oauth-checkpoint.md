# G01 checkpoint — Connect Gmail with an OAuth callback (issue #26)

Executed plan: `docs/superpowers/plans/tickets/G01-gmail-oauth.md` (openmuse worktree), full TDD:
RED (12-test state-machine suite) → GREEN (module + wiring) → this checkpoint. No commits made.

## Module

`server/src/openmuse-connectors/` — `client.ts` (vendor seam over injectable dial, split
build/create like `plugins/openconnector-adapter.ts`; base-URL validation at construction;
`redirect: "manual"`), `store.ts` (row seam + drizzle rows), `google-oauth.ts` (orchestration),
`routes.ts` (`/api/mobile/openmuse-google` connect+status behind `requireUser`; PUBLIC
`/api/public/openmuse-google/callback` resolving the session by hand — no session ⇒ 403).

## Migration SQL (verbatim, `drizzle/0079_faithful_shooting_star.sql`; NOT applied — no db:migrate)

```sql
CREATE TABLE "openmuse_google_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"account_email" text NOT NULL,
	"status" text DEFAULT 'connected' NOT NULL,
	"granted_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"alias" text NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openmuse_oauth_pending" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"return_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_google_connections_owner_provider_uq" ON "openmuse_google_connections" USING btree ("user_id","provider");
```

## Alias formula (server-derived, asserted exactly by the test)

`alias = "openmuse-" + sha256_hex(userId + "gmail").slice(0, 16)` — e.g. userId `user-1`
⇒ `openmuse-dad50426502c376c`. Never client-selected; deterministic so reconnect reuses the
vendor's one connection seat. Reconnect bumps `generation` via upsert (`generation + 1` on the
`(user_id, provider)` conflict); first consent records `generation: 1`.

## State machine (tests 1–9 of the matrix, all green)

pending row keyed by the VENDOR state parsed from the returned `authorizationUrl`; TTL 10 min
(410 expired); session-user match checked BEFORE consume (403 cross-session leaves the pending
usable); consume-once via compare-and-swap `UPDATE … WHERE consumed_at IS NULL` (second callback
400, exactly one exchange); wrong state 400 with zero vendor calls; vendor exchange failure 502
with pending consumed and no row (fresh start required, no retry); `/connect` without session 401,
callback without session cookie 403; no client built (unset/invalid OPENCONNECTOR_URL) ⇒ 503 with
deployment message; §9 hooks: `disableOwner` refuses connect (403), `enumerateOwner` returns
`{kind:"openmuse-google-connection", id}`. returnUri accepted only as `openmuse://…` or the
deployment's own http(s) origin (`allowedHttpOrigin`).

## redirectUri / origin deployment note (for O02)

`redirectUri = ${OPENBOT_PUBLIC_ORIGIN}/api/public/openmuse-google/callback`. `OPENBOT_PUBLIC_ORIGIN`
is read via `process.env` in `index.ts` (config.ts untouched per plan); O02 wires it into config.
At boot, when `GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` + the origin are all present,
`PUT /api/oauth/configs/gmail {clientId, clientSecret, redirectUri}` is pushed once to the vendor
(`gmailClientCredentialsFromEnv()` in `client.ts`; failure logged, never fatal). Without the
origin, no http(s) returnUri is accepted (only `openmuse://`) and no client config is pushed.
Vendor base: `OPENCONNECTOR_URL`, default `http://localhost:3000`.

## Real-Gmail consent — deferred (S15)

Real-Gmail consent evidence is **gate-level (S15) and NOT claimed here**. Everything verified is
against the fake vendor dial per the plan's authoritative doc excerpts. One seam to re-check at the
live gate: the callback forward is implemented as `GET /oauth/callback?code=…&state=…` (query per
docs); if the live vendor expects a POST body instead, change only `forwardCallback` in `client.ts`.

## Changed files (this ticket's increment over the prior uncommitted checkpoints)

New — `shasum -a 256`:

- `server/src/openmuse-connectors/client.ts` a76ded8ee1ba863c60b71e1623764ff46e5dbcd122c9cda3f70b82f0c68d5fdf
- `server/src/openmuse-connectors/google-oauth.ts` 112be12192ebb2ab5bb8a88ef4a696e5b463241d03b77bac572175a6c2d9effc
- `server/src/openmuse-connectors/routes.ts` df430bc55481a9072304703e018a5299f4693f50f42cfcdbb3adaacde126165a
- `server/src/openmuse-connectors/store.ts` 95b9b47337a15791181b5cde10f257cdcbe73e75534efce3a29609330b9f3a74
- `server/tests/openmuse-google-oauth.test.ts` 308d0d771a9c2663753853ceafa7ec4b3875c9662ad9443883f553dcd3aea427
- `server/drizzle/0079_faithful_shooting_star.sql` 4f12ad0f7e921306e374d1410b326d3c67544831bead675db90c700e564ed893
- `server/drizzle/meta/0079_snapshot.json` 980b9d4793ec436edfccb0dc39bed0221d98f925b49ae8d033481cf70ee5692c
- `docs/openmuse-v4/g01-gmail-oauth-checkpoint.md` (this file)

Modified:

- `server/src/app.ts` — appended `openMuseGoogleOAuth?` tail param + the two mounts.
- `server/src/index.ts` — imports, seam construction (guard/resolveActor/client/boot config push), appended arg.
- `server/src/db/schema/openmuse.ts` — the two tables (also sorted the file's pre-existing import order for biome).
- `server/drizzle/meta/_journal.json` — entry idx 79. shasum 5897239c1f4e35fedf7daf7190f3b703681b60b0e6c9b5a3639823049736493e
- `server/tests/ready.test.ts` — offset per its documented convention: `createApp.length - 4` → `- 5` (comment extended).
- `server/tests/self-host-banner.test.ts` — same convention; `- 14` → `- 16`. The checkpoint's
  `-14` was already off by one (banner landed on `billing`, one entitlements test failing before
  this ticket); now fixed and green.

## Verification (evidence)

`bun test tests/openmuse-google-oauth.test.ts tests/ready.test.ts tests/mobile-bff.test.ts` →
`22 pass / 0 fail, 81 expect() calls, Ran 22 tests across 3 files`.
Extended: the five suites above + `tests/schema.test.ts` `tests/openmuse-files.test.ts`
`tests/openmuse-tasks.test.ts` `tests/self-host-banner.test.ts` → `88 pass / 0 fail, 287 expect() calls, Ran 88 tests across 7 files`.
Typecheck `bun run build` (tsc --noEmit): 0 errors.
`bunx biome check` on all touched files: clean.
`tests/shared-wiring.integration.test.ts` fails at setup for want of `TEST_DATABASE_URL` —
pre-existing environmental (dedicated test database), untouched by this ticket.
