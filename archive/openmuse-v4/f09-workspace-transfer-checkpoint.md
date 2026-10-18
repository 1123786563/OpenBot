# F09 — Transfer a PDF version to Bot workspace: checkpoint

Issue #48 · ticket F09 · plan `docs/superpowers/plans/tickets/F09-workspace-transfer.md` (openmuse worktree) · no commit, per dispatch.

## Task 0 — gateway workspace-write seam citation

The server's ONLY write seam into a Bot computer workspace today:

- `ComputerGateway.writeFile(botId, actor, input: WriteFileInput)` — `server/src/computer/gateway.ts:1230` (impl; interface at `:206`), `WriteFileInput = { path, contents: string, append? }` at `server/src/computer/schema.ts:255`.
- Transport: `POST /files/write` → `agent-computer/src/index.ts:1225` → `workspace.write` (`agent-computer/src/workspace.ts:332`) — **utf8 text only**, default `writeBytes` cap **1,000,000** (`workspace.ts:95`).
- No other write route exists in agent-computer (full route list checked); `runCommand`/`exec` is the only other mutation, and there is **no delete** verb.

The seam EXISTS, so the plan's STOP-and-ask branch was not taken. Recorded limitation: a PDF (binary, up to `OPENMUSE_MAX_PDF_BYTES` = 10 MiB) cannot faithfully cross a utf8-text seam (re-encoding corrupts bytes ≥ 0x80; base64 both exceeds the 1 MiB cap for most files and is not a usable PDF artifact). Therefore `transfer.ts` injects a **bytes-shaped** `WorkspaceTransferFilesystem` seam (`list/read/write/remove`); production wiring to the gateway belongs to index.ts (outside this ticket's file ownership, like the unwired bot-tool seams of prior tickets) and needs no change to this module once a binary-capable write exists.

## Storage decision

Idempotency + collision records live in an **in-workspace json ledger** `openmuse-transfer/ledger.json` (`TRANSFER_LEDGER_PATH`), the pattern of craft/uploads.ts's `.openbot-uploads.json`: the ledger rides the workspace so snapshot/restore carries it with the files it describes, and a retry after a reset re-derives the same path instead of answering a stale one from a table the workspace has forgotten. **No migration**: `openmuse_files` has no jsonb metadata column (schema checked), and a DB table cannot see workspace resets at all.

Derived path: `openmuse-transfer/<fileId>/<versionId>-<n>.pdf`, n from 1, skipping names the workspace lists under the file's folder plus every ledger-complete artifact.

## Files (shasum)

```
696314589136f16a0e95efeec3451b1b2c5af02b  server/src/openmuse-documents/transfer.ts   (new, 151 lines)
fbf4802adea29cdbebac34ce41e11ec3c7230f06  server/src/openmuse-documents/routes.ts    (modified)
bc846f5de75e2f75ed34a6a628a8dadbe1d9480c  server/tests/openmuse-documents.test.ts    (modified, 1019 lines)
```

No migration. app.ts / index.ts untouched by this ticket (their `M` flags are prior checkpoints).

## Behavior implemented

`POST /api/mobile/openmuse-files/:id/transfer { versionId, transferKey }` — client destination ignored; owner-scoped 404 (foreign/tombstoned); §9-disabled 403; non-PDF 400; oversize 413; missing fields 400; stale versionId 409 (v1 transfers only the current version — the store reads no historical version's bytes; recorded in route comment); unwired seam 503; success 201 (new artifact) / 200 (idempotent replay); mid-write failure → best-effort artifact removal + failed marker + 503, never complete.

## Verification (test tails)

```
bun test tests/openmuse-documents.test.ts tests/ready.test.ts
  48 pass · 0 fail · 168 expect() calls · Ran 48 tests across 2 files
bun run build (tsc --noEmit) → exit 0
bunx biome check <3 owned files> → checked, no errors
```

RED was confirmed first (module-not-found before implementation).

## S27 deferred note

S27 (acceptance) transfers a copy twice into a live K-A private computer workspace. Its matrix (server-derived path, stable artifact on retry, same-name not overwritten) is covered by the injected-seam unit tests; the **live fixture is deferred** because production wiring of the workspace seam lives in index.ts (outside this ticket's ownership) and the gateway's text-only write cannot carry binary PDFs yet — a gateway capability decision flagged for the coordinator.

## Concurrent ownership respected

openmuse-activity (V02) and openmuse-tasks (T16) modules untouched; prior uncommitted checkpoints in the worktree untouched.
