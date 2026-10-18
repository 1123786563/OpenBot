# F01 checkpoint — Upload and list one personal File (Issue #39)

Status: implemented, all green, NO commit. Worktree `/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base`, branch `v4/openbot-exec`.

## Task 0 answers

1. **Byte-storage prior art.** Channel attachments store bytes as Postgres `bytea` (`server/src/db/schema/core.ts:538`) — no local directory, no reusable files seam. `server/src/craft/storage/object-store.ts` IS a generic put/get/has/delete seam, but its factory `createObjectStore` requires craft's full `CraftStorageConfig` (mandatory S3 fields), so a files deployment wanting only a local dir would fabricate config. **Decision (approved by coordinator): local-dir `FileByteStore` in `server/src/openmuse-files/bytes.ts`, key `openmuse-files/<ownerId>/<fileId>/<versionId>`, path rules mirroring craft's `LocalObjectStore` (refuse absolute/`..`, mkdir -p, idempotent delete). Duplication flagged for reviewer attention** per plan failure-handling.
2. **Mobile-bff assembly.** I02's pattern needs an app.ts createApp tail-param plus app.ts wiring into `createMobileBffRoutes` deps (requireUser is constructed inside createApp, `app.ts:849`). With app.ts frozen this was unsatisfiable; coordinator approved lifting the freeze (option C): appended `openMuseFiles?: OpenMuseFileStore` as the LAST createApp param, wired into the `/api/mobile` mount exactly like `openMuseTemplateStore`; index.ts contributes import + one tail arg. The files sub-app mounts via a new optional `openMuseFiles` dep in `createMobileBffRoutes` **before** the family 8 KiB `bodyLimit` (which moved after the mount) so that JSON-sized limit never wraps a 20 MiB upload; the sub-app carries its own requireUser + 20 MiB+64 KiB bodyLimit.

## Chosen upload encoding

**`multipart/form-data` with one `file` part** (rejected: raw body + `X-File-Name`/`X-File-Type` headers) — the filename travels in the part header where browsers and Expo FormData encode UTF-8 natively; no RFC 5987 handshake for CJK/emoji names. `Idempotency-Key` header (optional, ≤255; absent = no dedup). Discovered en route (and matching `channels/attachments.ts:712`'s documented behavior): this deployment's Bun multipart parser **ignores per-part Content-Type and derives `File.type` from the filename extension**, so the stored mimeType is earned with the attachment stack's own `sniffMimeType(bytes, part.type)`; PDF-ness additionally triggers on `%PDF-` magic so a false non-PDF claim still gets the 10 MiB ceiling.

## Migration SQL (verbatim, `server/drizzle/0077_bumpy_lila_cheney.sql`)

```sql
CREATE TABLE "openmuse_file_owner_disables" (
	"owner_user_id" text PRIMARY KEY NOT NULL,
	"disabled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openmuse_file_versions" (
	"version_id" text PRIMARY KEY NOT NULL,
	"file_id" text NOT NULL,
	"byte_path" text NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "openmuse_files" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "openmuse_file_owner_disables" ADD CONSTRAINT "openmuse_file_owner_disables_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_file_versions" ADD CONSTRAINT "openmuse_file_versions_file_id_openmuse_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."openmuse_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "openmuse_files" ADD CONSTRAINT "openmuse_files_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "openmuse_file_versions_file_idx" ON "openmuse_file_versions" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "openmuse_files_owner_list_idx" ON "openmuse_files" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "openmuse_files_owner_idem_uq" ON "openmuse_files" USING btree ("owner_user_id","idempotency_key") WHERE "openmuse_files"."deleted_at" is null;
```

`idempotency_key` is nullable — Postgres treats NULLs as distinct, so keyless uploads never collide; the partial unique index enforces owner-scoped dedup for keyed retries (NULL keys never dedup by construction).

## Changed files + shasum (sha256)

New:
- `43debd55…41b19 server/src/openmuse-files/bytes.ts` — FileByteStore seam + local-dir impl + `openMuseFileByteKey`
- `a8b14327…c05f  server/src/openmuse-files/store.ts` — store logic over `OpenMuseFileRows` seam + drizzle rows impl + §9 hooks (`OpenMuseOwnerDisabledError`, restoreOwner = clear marker, purge = no-op by scope, see file comments)
- `bbdb20f7…838a7 server/src/openmuse-files/routes.ts` — POST (multipart, sniff, 20/10 MiB, idempotency) + GET (25 default/100 max clamp, opaque base64 cursor `{createdAt,id}`)
- `1725dc63…13f6  server/src/db/schema/openmuse.ts` — three tables
- `967116a8…7a11  server/tests/openmuse-files.test.ts` — 16 tests (plan cases 1–8 + mount + pagination)
- `c27603b3…67c5  server/drizzle/0077_bumpy_lila_cheney.sql`, `98fa90ed…672c server/drizzle/meta/0077_snapshot.json`, `_journal.json` updated

Modified (mount/assembly only where planned):
- `5aebda9c…119f  server/src/mobile-bff/routes.ts` — optional `openMuseFiles` dep, mount before family bodyLimit
- `f0b0fbae…c203  server/src/app.ts` — one import pair, one appended tail param, one conditional dep wiring (option C, approved)
- `17959159…9254  server/src/index.ts` — import + one createApp tail arg (`OPENBOT_OPENMUSE_FILES_DIR` env, default `.openmuse/files`, mirroring craft's `.craft/storage` convention); no stream-block text touched
- `1915c85e…a3c2  server/src/db/schema/index.ts`, `31162fe7…681c5 server/drizzle.config.ts` — register schema file
- `424f2f51…c87ac server/tests/ready.test.ts` — probe offset `-2`→`-3` (documented maintenance)
- `63142cbf…5ae7  server/tests/self-host-banner.test.ts` — banner offset `-3`→`-14`: **pre-existing breakage** (earlier checkpoints I02/I09 appended params without updating this offset; verified failing before my change, root-caused by parsing createApp's 49 params — banner at index 35)

## Test tails

```
bun test tests/openmuse-files.test.ts → 16 pass / 0 fail (49 expect)
bun test tests/openmuse-files.test.ts tests/mobile-bff.test.ts tests/openmuse-bot.test.ts → 31 pass / 0 fail
+ tests/ready.test.ts tests/self-host-banner.test.ts (server file) → 61 pass / 0 fail total
(app/tests/self-host-banner.test.tsx carries a pre-existing unhandled React error, verified present with my changes stashed)
bun run typecheck → exit 0
biome check (all owned/touched files) → clean, no fixes applied
```

## Left for later tickets (not F01)

- F02: content access/download enforcement; PDF page-limit + inspection (F05); rename/new versions; workspace transfer.
- Deletion tickets D04–D08: wire `disableOwner`/`enumerateOwner` into the lifecycle seam and cleanup manifest (`ResourceRef` {kind:"openmuse-file", id, externalKey} is exposed on the store).
- Ops: `OPENBOT_OPENMUSE_FILES_DIR` needs backup coverage in the deployment baseline (O-series).
