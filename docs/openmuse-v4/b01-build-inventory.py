#!/usr/bin/env python3
"""B01 reconciliation inventory builder. Read-only on both trees.

Enumerates the copied client (apps/openmuse-mobile) and the canonical client
(apps/mobile), diffs every path pair, classifies each row, and emits:
  - docs/openmuse-v4/b01-copied-client-inventory.json  (machine-readable rows)
  - docs/openmuse-v4/b01-copied-client-inventory.md    (grouped table + header)

Modes:
  (default)      build rows, write JSON + MD, print summary
  --list-only    print both file lists and counts, write nothing
  --verify       rebuild in memory, run the four coverage self-checks (OK lines)

Canonical paths are relative to apps/mobile, except rows under packages/
which are relative to the OpenMuse monorepo root (vendored-domain mapping,
plan Task 2 rule 5).

Post-B04: the copied tree is deleted from the worktree; this script and the
generated manifest stand as the archived final record (regeneration requires
both trees present, i.e. pre-removal state).
"""
import datetime
import hashlib
import json
import subprocess
import sys
from pathlib import Path

COPIED = Path("/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base/apps/openmuse-mobile")
CANON = Path("/Users/wuyongjun/trea/openmuse/.worktrees/v4-base/apps/mobile")
CANON_MONOREPO = Path("/Users/wuyongjun/trea/openmuse/.worktrees/v4-base")
OUT_MD = Path("/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base/docs/openmuse-v4/b01-copied-client-inventory.md")
OUT_JSON = Path("/Users/wuyongjun/trea/OpenBot/.worktrees/v4-base/docs/openmuse-v4/b01-copied-client-inventory.json")

EXCLUDE_DIRS = {"node_modules", ".expo", "android", "ios", "dist"}

CANON_BASE_SHA = "46792335"
COPIED_BASE_SHA = "748f91ad"
EXPECTED_COPIED_COUNT = 71
EXPECTED_CANON_COUNT = 108

HASH_RULE = (
    'File difference hash = sha256( ("identical"|"differs") + "\\n" + unified_diff_text ), '
    "where unified_diff_text is the output of "
    "`diff -u -L canonical/<canonical_path> -L copied/<copied_path> <canonical file> <copied file>`. "
    "For copied-only/canonical-only rows the hash is sha256( (\"copied-only\"|\"canonical-only\") + \"\\n\" "
    "+ hex(sha256(file bytes)) ). Labels are fixed so hashes are machine-independent and reproducible."
)

REGENERATE_CMD = "python3 docs/openmuse-v4/b01-build-inventory.py && python3 docs/openmuse-v4/b01-build-inventory.py --verify"


def walk(root: Path):
    files = {}
    for p in sorted(root.rglob("*")):
        if p.is_dir():
            continue
        rel = p.relative_to(root).as_posix()
        if any(part in EXCLUDE_DIRS for part in Path(rel).parts[:-1]):
            continue
        files[rel] = p
    return files


def file_kind(rel: str) -> str:
    name = Path(rel).name
    if rel.startswith("test/"):
        return "test"
    if name == "bun.lock" or name.endswith(".lock"):
        return "lockfile"
    if rel.startswith("assets/"):
        return "asset"
    if name in {"tsconfig.json", "app.json", "package.json", "metro.config.js", ".gitignore", ".npmrc"}:
        return "config"
    if name.endswith(".md"):
        return "doc"
    return "source"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def pair_hash(canon_file: Path, copied_file: Path, canonical_path: str, copied_path: str):
    """Returns (status, difference_hash) for a mapped path pair."""
    proc = subprocess.run(
        ["diff", "-u", "-L", f"canonical/{canonical_path}", "-L", f"copied/{copied_path}",
         str(canon_file), str(copied_file)],
        capture_output=True, text=True,
    )
    diff_text = proc.stdout
    if proc.returncode == 0 and not diff_text:
        marker = "identical"
    elif proc.returncode in (0, 1):
        marker = "differs"
    else:
        raise RuntimeError(f"diff failed for {copied_path}: {proc.stderr}")
    return marker, sha256_bytes((marker + "\n" + diff_text).encode())


def only_hash(kind: str, f: Path) -> str:
    return sha256_bytes((kind + "\n" + sha256_bytes(f.read_bytes())).encode())


# plan Task 2 rule 5: vendored packages/domain maps to the OpenMuse monorepo copy
def canonical_counterpart(rel: str):
    if not rel.startswith("packages/"):
        return None
    candidate = CANON_MONOREPO / rel
    return candidate if candidate.is_file() else None


PATH_ONLY_INTENT = (
    "vendored domain import path rewrite (../../../packages/domain/src -> ../packages/domain/src, "
    "per MIGRATION.md); unnecessary once the submodule build (B02/B03) uses the canonical tree, "
    "copy deleted at B04"
)
CATALOG_INTENT = (
    "canonical 46792335 ported the zh-CN UI into a src/strings.ts catalog (t() lookups); "
    "the copy keeps its earlier inline zh-CN literals, so the difference is implementation "
    "form only and dies with the copy at B04"
)
CATALOG_ONLY_INTENT = (
    "canonical zh-CN string catalog (and its tests), added upstream at 46792335; "
    "the copy predates the catalog; divergence disappears when B04 replaces the copy "
    "with the canonical tree"
)
# paths whose zh-CN inline localization canonical 46792335 adopted via src/strings.ts
CATALOG_LOCALIZED_PATHS = [
    "src/agent-ui.tsx",
    "src/background-updates.tsx",
    "src/browser-tool-card.tsx",
    "src/chat.tsx",
    "src/computer-workspace.tsx",
    "src/computer.tsx",
    "src/desktop-stream.tsx",
    "src/desktop-tool-card.tsx",
    "src/details.tsx",
    "src/jev-actions.ts",
    "src/mail-tool-card.tsx",
    "src/relative-date.ts",
    "src/screens.tsx",
    "src/search-tool-card.tsx",
    "src/thread-artifacts.tsx",
    "src/threads.tsx",
    "src/ui.tsx",
    "src/BrowserConsole.web.tsx",
    "src/DateTimeEditor.tsx",
]

# path -> (intent, target_ticket); ticket None requires an 'Unmapped rows' entry;
# canonical-only rows are keyed "canonical-only:<canonical_path>"
ANNOTATE = {
    "App.tsx": ("OpenBot session integration: OpenBotGate sign-in gate, SignOutButton, openbotBackend switch (src/openbot/*), plus pre-catalog inline zh-CN and vendored-domain path rewrite; adopted by the canonical v4-base worktree at I01 (I03 entry sequence, later screens extend it) — the copy is the stale seed", "I01"),
    "README.md": ("copied-tree bookkeeping: demo media/doc relative links rewritten to upstream pinned-commit absolute URLs, commands run from package dir (MIGRATION.md)", "B04"),
    "metro.config.js": ("watchFolders changed from source monorepo root to the package dir so Metro does not watch the whole OpenBot backend repo (MIGRATION.md); canonical config works as-is under the submodule (B02/B03), copy change dies with B04", "B04-cleanup"),
    "tsconfig.json": ("paths['@openmuse/domain'] pointed at the in-package vendored copy (MIGRATION.md); canonical keeps its own mapping under the submodule, copy change dies with B04", "B04-cleanup"),
    "src/date-time.ts": (PATH_ONLY_INTENT, "B04-cleanup"),
    "src/jev-tool-card.tsx": (PATH_ONLY_INTENT, "B04-cleanup"),
    "src/workspace.tsx": (PATH_ONLY_INTENT, "B04-cleanup"),
    "test/jev-actions.test.ts": (PATH_ONLY_INTENT + "; canonical 46792335 additionally localized the test fixtures to zh-CN, which the copy predates", "B04-cleanup"),
    ".gitignore": ("copied-tree bookkeeping: upstream ignore rules lived at the source repo root and had to be re-created for the standalone package (MIGRATION.md)", "B04"),
    ".npmrc": ("copied-tree bookkeeping: reproduces the source repo's pnpm peer-dependency behavior outside the workspace (MIGRATION.md)", "B04"),
    "MIGRATION.md": ("copied-tree bookkeeping: migration record for the copy itself, removed with the subtree at B04", "B04"),
    "bun.lock": ("copied-tree bookkeeping: lockfile produced by the standalone Bun install on the OpenBot side (upstream uses pnpm-lock)", "B04"),
    "src/openbot/api.ts": ("OpenBot REST facade (zod-checked /api/me, workspace, conversations, history, message send, activity): adopted by the canonical v4-base worktree at I01 and extended by later client tickets (files/tasks/calendar/connections/provisioning)", "I01"),
    "src/openbot/auth.ts": ("Better Auth client with @better-auth/expo + SecureStore native session persistence and web cookie storage: adopted by the canonical v4-base worktree (native restore I04, Android twin I05)", "I04"),
    "src/openbot/client.ts": ("OpenBot HTTP transport (Cookie header injection, 20s timeout/abort, 401->authentication_required / 403->refused mapping, outcomeUnknown on 5xx/408 writes): adopted by the canonical v4-base worktree at I01, extended with binary downloads (F04)", "I01"),
    "src/openbot/config.ts": ("EXPO_PUBLIC_OPENBOT_URL / EXPO_PUBLIC_BACKEND backend-selection switch with URL validation and loopback normalization: adopted by the canonical v4-base worktree at I01 (+I05 Android delta)", "I01"),
    "src/openbot/email-signin.tsx": ("email/password sign-in and sign-up form plus SignOutButton on Better Auth: adopted by the canonical v4-base worktree at I01", "I01"),
    "src/openbot/errors.ts": ("OpenBot error model (nine error codes incl. authentication_required): adopted by the canonical v4-base worktree at I01", "I01"),
    "src/openbot/gate.tsx": ("OpenBotGate session gate: adopted by the canonical v4-base worktree at I01 and extended at I03 (provision->workspace->conversation entry sequence)", "I01"),
    "src/openbot/types.ts": ("zod DTO schemas for OpenBot mobile endpoints: adopted by the canonical v4-base worktree at I01 and extended by later tickets (files/tasks/calendar/connections)", "I01"),
    "app.json": ("canonical 46792335 localized the web app name to zh-CN; the copy keeps the English name; divergence dies with the copy at B04", "B04-cleanup"),
    "src/DateFields.native.tsx": ("canonical 46792335 switched user-visible strings to t() lookups from src/strings.ts; the copy was never localized and keeps English inline strings; divergence dies with the copy at B04", "B04-cleanup"),
    "src/DateFields.web.tsx": ("canonical 46792335 switched user-visible strings to t() lookups from src/strings.ts; the copy was never localized and keeps English inline strings; divergence dies with the copy at B04", "B04-cleanup"),
    "src/PdfReader.web.tsx": ("canonical 46792335 switched user-visible strings to t() lookups from src/strings.ts; the copy was never localized and keeps English inline strings; divergence dies with the copy at B04", "B04-cleanup"),
    "test/relative-date.test.ts": ("canonical 46792335 localized the relative-date test fixtures to zh-CN; the copy predates that change; divergence dies with the copy at B04", "B04-cleanup"),
    "src/agent-workspace.tsx": ("zh-CN strings inline only in the copied tree (canonical's 46792335 catalog has no entries for this file) plus the vendored-domain path rewrite; gap recorded below, dies with the copy at B04", "B04-cleanup"),
    "src/browser-address.ts": ("zh-CN strings inline only in the copied tree (canonical's 46792335 catalog has no entries for this file); gap recorded below, dies with the copy at B04", "B04-cleanup"),
    "src/computer-status.ts": ("zh-CN strings inline only in the copied tree (canonical's 46792335 catalog has no entries for this file); gap recorded below, dies with the copy at B04", "B04-cleanup"),
    "canonical-only:src/strings.ts": (CATALOG_ONLY_INTENT, "B04-cleanup"),
    "canonical-only:test/strings.test.ts": (CATALOG_ONLY_INTENT, "B04-cleanup"),
}
for _p in CATALOG_LOCALIZED_PATHS:
    ANNOTATE[_p] = (CATALOG_INTENT, "B04-cleanup")

# paths formerly 'Unmapped rows' (zh-CN inline only in copy, no canonical catalog
# entries): resolved at B04 per the manifest's recorded option 2 — B04-cleanup with
# the gap recorded in the MD; no row carries a null ticket any more.
UNMAPPED_I18N_PATHS = []

# ---- B04 resolution layer (B04 plan Task 1) ----
# The canonical v4-base worktree adopted the copy's session layer as an uncommitted
# checkpoint on 46792335 (apps/mobile/src/openbot/*, App.tsx, package.json — the last
# now byte-identical), then grew it via the v4 client tickets (ledger
# 2026-10-12-openbot-v4-execution). RESOLVE keys mirror ANNOTATE (canonical-only rows
# keyed "canonical-only:<path>"); identical rows resolve trivially.
TRIVIAL = "trivial (identical)"
PARITY = "canonical-parity 46792335"
B04_DEATH = "resolved-by B04 — copy-tree bookkeeping, dies with the copy"
SUBMODULE_BUILD = "resolved-by B02/B03 — canonical tree builds unmodified under the submodule"
GAP_DEATH = "resolved-by B04 — inline zh-CN dies with the copy; localization gap recorded below"
CANON_ADD = "landed-in-canonical {t} — canonical addition, no copy counterpart"

# supersession citations: file:line in the OpenMuse v4-base worktree (uncommitted
# checkpoint on 46792335), the artifact that superseded the copy's row
SUPERSEDED = {
    "App.tsx": "superseded-by I01/I03 — apps/mobile/App.tsx:139 (OpenBotGate entry)",
    "src/openbot/api.ts": "superseded-by I01/I03 — apps/mobile/src/openbot/api.ts:37 (fetchMe)",
    "src/openbot/auth.ts": "superseded-by I04/I05 — apps/mobile/src/openbot/auth.ts:28 (authClient)",
    "src/openbot/client.ts": "superseded-by I01 — apps/mobile/src/openbot/client.ts:119 (openbotFetch)",
    "src/openbot/config.ts": "superseded-by I01/I05 — apps/mobile/src/openbot/config.ts:13 (EXPO_PUBLIC_OPENBOT_URL)",
    "src/openbot/email-signin.tsx": "superseded-by I01 — apps/mobile/src/openbot/email-signin.tsx:55 (EmailSignInForm)",
    "src/openbot/errors.ts": "superseded-by I01 — apps/mobile/src/openbot/errors.ts:25 (OpenBotError)",
    "src/openbot/gate.tsx": "superseded-by I01/I03 — apps/mobile/src/openbot/gate.tsx:93 (OpenBotGate)",
    "src/openbot/types.ts": "superseded-by I01 — apps/mobile/src/openbot/types.ts:21 (openBotSessionSchema)",
}

# canonical-only additions since 46792335: landed client work under src/openbot/
# (v4 execution tickets); the copy predates the submodule switch and never carried
# these — canonical growth, not copy loss
CANONICAL_ADDITIONS = {
    "src/openbot/calendar-view.ts": "A03",
    "src/openbot/calendar.tsx": "A03",
    "src/openbot/channel-actions.ts": "C03",
    "src/openbot/channel-state.ts": "C02",
    "src/openbot/channels.tsx": "C02",
    "src/openbot/chat-state.ts": "C01",
    "src/openbot/chat.tsx": "C01",
    "src/openbot/computer-state.ts": "K02",
    "src/openbot/computer.tsx": "K02",
    "src/openbot/connection-status.ts": "G06",
    "src/openbot/connections.tsx": "G06",
    "src/openbot/control-state.ts": "K04",
    "src/openbot/control.tsx": "K04",
    "src/openbot/file-cache.ts": "F04",
    "src/openbot/files.tsx": "F04",
    "src/openbot/gate-state.ts": "I01/I03",
    "src/openbot/pdf-view-state.ts": "F07/F08",
    "src/openbot/pdf-view.tsx": "F07/F08",
    "src/openbot/private-state.ts": "I06/I07/I08",
    "src/openbot/stop-state.ts": "C04",
    "src/openbot/stream-resume.ts": "C05",
    "src/openbot/task-view.ts": "T03",
    "src/openbot/tasks.tsx": "T03",
    "src/openbot/tool-cards.ts": "C06",
    "test/openbot-android-config.test.ts": "I05",
    "test/openbot-api.test.ts": "I01/I03",
    "test/openbot-calendar-view.test.ts": "A03",
    "test/openbot-channel-actions.test.ts": "C03",
    "test/openbot-channel-state.test.ts": "C02",
    "test/openbot-chat-state.test.ts": "C01",
    "test/openbot-client.test.ts": "I01/I04",
    "test/openbot-computer-state.test.ts": "K02",
    "test/openbot-connection-status.test.ts": "G06",
    "test/openbot-control-state.test.ts": "K04",
    "test/openbot-file-cache.test.ts": "F04/F10",
    "test/openbot-gate.test.ts": "I01/I03/I06",
    "test/openbot-native-private-state.test.ts": "I07/I08",
    "test/openbot-native-session.test.ts": "I04/I05",
    "test/openbot-pdf-view-state.test.ts": "F07/F08",
    "test/openbot-private-state.test.ts": "I06",
    "test/openbot-stop-state.test.ts": "C04",
    "test/openbot-stream-resume.test.ts": "C05",
    "test/openbot-task-view.test.ts": "T03",
    "test/openbot-tool-cards.test.ts": "C06",
}
CANONICAL_ADDITION_INTENT = (
    "canonical addition landed by ticket {t} in the OpenMuse v4-base worktree "
    "(uncommitted checkpoint on 46792335); the copy predates the submodule switch and "
    "never carried it — canonical growth, not copy loss"
)
for _p, _t in CANONICAL_ADDITIONS.items():
    ANNOTATE["canonical-only:" + _p] = (CANONICAL_ADDITION_INTENT.format(t=_t), _t)

RESOLVE = {}
RESOLVE.update(SUPERSEDED)
for _p in ("README.md", ".gitignore", ".npmrc", "MIGRATION.md", "bun.lock"):
    RESOLVE[_p] = B04_DEATH
for _p in ("metro.config.js", "tsconfig.json", "src/date-time.ts", "src/jev-tool-card.tsx", "src/workspace.tsx"):
    RESOLVE[_p] = SUBMODULE_BUILD
RESOLVE["test/jev-actions.test.ts"] = (
    "canonical-parity 46792335 (zh-CN fixtures); path rewrite unnecessary under the submodule (B02/B03)"
)
for _p in CATALOG_LOCALIZED_PATHS + [
    "src/DateFields.native.tsx", "src/DateFields.web.tsx", "src/PdfReader.web.tsx",
    "app.json", "test/relative-date.test.ts",
]:
    RESOLVE[_p] = PARITY
for _p in ("src/agent-workspace.tsx", "src/browser-address.ts", "src/computer-status.ts"):
    RESOLVE[_p] = GAP_DEATH
RESOLVE["canonical-only:src/strings.ts"] = "landed-in-canonical 46792335 — zh-CN string catalog supersedes the copy's inline literals"
RESOLVE["canonical-only:test/strings.test.ts"] = "landed-in-canonical 46792335 — zh-CN string catalog tests"
for _p, _t in CANONICAL_ADDITIONS.items():
    RESOLVE["canonical-only:" + _p] = CANON_ADD.format(t=_t)


def check_baselines():
    for root, expected, label in ((CANON_MONOREPO, CANON_BASE_SHA, "canonical"),
                                  (COPIED.parents[1], COPIED_BASE_SHA, "copied")):
        sha = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                             capture_output=True, text=True, check=True).stdout.strip()
        if not sha.startswith(expected):
            sys.exit(f"STOP: {label} baseline is {sha}, expected {expected} (plan failure handling)")


def build_rows():
    copied = walk(COPIED)
    canon = walk(CANON)
    rows = []
    for rel in sorted(copied):
        counterpart = canonical_counterpart(rel)
        canon_rel = None
        canon_file = None
        if counterpart is not None:
            canon_rel = rel  # monorepo-relative (packages/...)
            canon_file = counterpart
        elif rel in canon:
            canon_rel = rel  # apps/mobile-relative
            canon_file = canon[rel]
        if canon_file is None:
            rows.append({
                "copied_path": rel, "canonical_path": None, "status": "copied_only",
                "difference_hash": only_hash("copied-only", copied[rel]),
                "kind": file_kind(rel), "intent": "", "target_ticket": None,
                "resolved_commit": None,
            })
            continue
        marker, dh = pair_hash(canon_file, copied[rel], canon_rel, rel)
        rows.append({
            "copied_path": rel, "canonical_path": canon_rel,
            "status": "identical" if marker == "identical" else "diverged",
            "difference_hash": dh, "kind": file_kind(rel),
            "intent": "", "target_ticket": None, "resolved_commit": None,
        })
    for rel in sorted(set(canon) - set(copied)):
        rows.append({
            "copied_path": None, "canonical_path": rel, "status": "canonical_only",
            "difference_hash": only_hash("canonical-only", canon[rel]),
            "kind": file_kind(rel), "intent": "", "target_ticket": None,
            "resolved_commit": None,
        })
    for row in rows:
        if row["status"] == "identical":
            row["intent"] = "in sync"
            row["resolved_commit"] = TRIVIAL
            continue
        key = row["copied_path"] if row["copied_path"] is not None else "canonical-only:" + row["canonical_path"]
        ann = ANNOTATE.get(key)
        if ann is not None:
            row["intent"], row["target_ticket"] = ann
        row["resolved_commit"] = RESOLVE.get(key)
    return copied, canon, rows


def verify(copied, canon, rows):
    ok = []
    # (a) union coverage: every path from both trees in exactly one row
    copied_in_rows = [r["copied_path"] for r in rows if r["copied_path"] is not None]
    canon_in_rows = [r["canonical_path"] for r in rows
                     if r["canonical_path"] is not None
                     and (r["copied_path"] is None or not r["copied_path"].startswith("packages/"))]
    assert len(copied_in_rows) == len(set(copied_in_rows)) == len(copied), "row/copied-path mismatch"
    assert set(copied_in_rows) == set(copied), "copied tree not fully covered"
    assert sorted(canon_in_rows) == sorted(canon), "canonical tree not fully covered"
    assert len(rows) == len(copied) + len(set(canon) - set(copied)), "row count != union"
    ok.append("(a) union coverage of both trees")

    # (b) every row has a difference_hash
    for r in rows:
        h = r["difference_hash"]
        assert isinstance(h, str) and len(h) == 64 and int(h, 16) >= 0, f"bad hash {r}"
    ok.append("(b) every row has difference_hash")

    # (c) every non-identical row annotated AND resolved (B04 gate: every row names
    # a resolution; ticket null only in UNMAPPED list, which is empty since B04)
    for r in rows:
        if r["status"] == "identical":
            continue
        assert r["intent"], f"missing intent: {r}"
        assert r["resolved_commit"], f"missing resolution: {r}"
        if r["target_ticket"] is None:
            assert r["copied_path"] in UNMAPPED_I18N_PATHS, f"null ticket not documented: {r['copied_path']}"
    assert set(UNMAPPED_I18N_PATHS) <= {r["copied_path"] for r in rows if r["copied_path"]}, "unmapped list names a non-existent path"
    ok.append("(c) every non-identical row annotated + resolved")

    # (d) counts printed match walk() counts and the expected constants
    assert len(copied) == EXPECTED_COPIED_COUNT, f"copied count {len(copied)} != {EXPECTED_COPIED_COUNT}"
    assert len(canon) == EXPECTED_CANON_COUNT, f"canonical count {len(canon)} != {EXPECTED_CANON_COUNT}"
    status_counts = {s: sum(1 for r in rows if r["status"] == s)
                     for s in ("identical", "diverged", "copied_only", "canonical_only")}
    inter = set(copied) & (set(canon) | {p for p in copied if p.startswith("packages/") and canonical_counterpart(p)})
    assert status_counts["identical"] + status_counts["diverged"] == len(inter), "intersection mismatch"
    ok.append(f"(d) counts match: copied={len(copied)} canonical={len(canon)} " +
              " ".join(f"{s}={n}" for s, n in status_counts.items()))
    return ok


def md_cell(text):
    if text is None:
        return "null"
    return str(text).replace("|", "\\|").replace("\n", " ")


def write_md(rows, copied, canon):
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    status_counts = {s: sum(1 for r in rows if r["status"] == s)
                     for s in ("identical", "diverged", "copied_only", "canonical_only")}
    lines = [
        "# B01 — Copied-client difference inventory (OpenBot `apps/openmuse-mobile` vs canonical OpenMuse `apps/mobile`)",
        "",
        f"- Canonical baseline: OpenMuse v4-base worktree @ `{CANON_BASE_SHA}` (`{CANON}`)",
        f"- Copied baseline: OpenBot v4-base worktree @ `{COPIED_BASE_SHA}` (`{COPIED}`)",
        f"- File counts: copied = {len(copied)} (excl. {', '.join(sorted(EXCLUDE_DIRS))}), canonical = {len(canon)}, rows = {len(rows)} "
        f"(identical {status_counts['identical']}, diverged {status_counts['diverged']}, copied_only {status_counts['copied_only']}, canonical_only {status_counts['canonical_only']})",
        f"- Difference-hash rule (verbatim): {HASH_RULE}",
        "- Path namespaces: `canonical_path` is relative to `apps/mobile`; rows whose path starts with `packages/` are relative to the OpenMuse monorepo root (vendored-domain mapping, plan Task 2 rule 5).",
        f"- Generated (UTC): {now}",
        f"- Regenerate: `{REGENERATE_CMD}`",
        f"- Amendment: regenerated after user committed main 46792335; prior manifest at 1ac68f3 archived as docs/openmuse-v4/b01-copied-client-inventory.1ac68f3.md",
        "- Amendment (B04 Task 1): the canonical v4-base worktree adopted the copy's session layer as an uncommitted checkpoint on 46792335 (apps/mobile/src/openbot/*, App.tsx; package.json now byte-identical) and grew it via the v4 client tickets — canonical count 56 → 108 (dist/ build output excluded), every row re-resolved. Supersession citations point into that worktree state.",
        "- Resolution vocabulary: `canonical-parity 46792335` = canonical (committed at the pin) carries the same adaptation; `superseded-by <ticket> — <file>:<line>` = the adaptation lives in the canonical v4-base worktree checkpoint; `landed-in-canonical <ticket>` = canonical-only addition, no copy counterpart; `resolved-by B02/B03` = canonical builds unmodified under the submodule; `resolved-by B04` = copy-tree artifact that dies with the copy.",
        "",
    ]
    for status in ("diverged", "copied_only", "canonical_only", "identical"):
        group = [r for r in rows if r["status"] == status]
        lines.append(f"## {status} ({len(group)})")
        lines.append("")
        lines.append("| copied path | canonical path | status | difference hash (first 12) | kind | intent | target Ticket | resolved commit |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- | --- |")
        for r in group:
            lines.append("| " + " | ".join(md_cell(x) for x in (
                r["copied_path"], r["canonical_path"], r["status"],
                r["difference_hash"][:12], r["kind"], r["intent"],
                r["target_ticket"] if r["target_ticket"] is not None else "null",
                r["resolved_commit"] if r["resolved_commit"] is not None else "null",
            )) + " |")
        lines.append("")
    lines += [
        "## Localization gap record (resolved at B04)",
        "",
        "Canonical 46792335 adopted the zh-CN UI as a `src/strings.ts` catalog, but its localization",
        "did not reach these three files: their zh-CN strings still exist only as inline literals in",
        "the copied tree (and `src/agent-workspace.tsx` additionally carries the vendored-domain path",
        "rewrite). Resolved at B04 per the previously recorded option 2: the rows carry `B04-cleanup`",
        "with this gap recorded — folding them into the upstream catalog remains open follow-up work.",
        "",
    ]
    lines += [f"- `{p}`" for p in ("src/agent-workspace.tsx", "src/browser-address.ts", "src/computer-status.ts")]
    lines += [
        "",
        "The 19 former zh-CN rows are annotated `B04-cleanup` / `canonical-parity 46792335`: upstream",
        "adopted the same localization via the catalog, so their difference is implementation form",
        "only (inline literals vs `t()` lookups) and dies with the copied subtree at B04.",
        "",
    ]
    OUT_MD.write_text("\n".join(lines) + "\n")


def main():
    check_baselines()
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    copied, canon, rows = build_rows()

    if mode == "--list-only":
        print("== copied tree (apps/openmuse-mobile) ==")
        for rel in sorted(copied):
            print(rel)
        print(f"copied count: {len(copied)} (expected {EXPECTED_COPIED_COUNT})")
        print("== canonical tree (apps/mobile) ==")
        for rel in sorted(canon):
            print(rel)
        print(f"canonical count: {len(canon)} (expected {EXPECTED_CANON_COUNT})")
        if len(copied) != EXPECTED_COPIED_COUNT or len(canon) != EXPECTED_CANON_COUNT:
            sys.exit("FAIL: tree counts differ from expected; re-check EXCLUDE_DIRS")
        return

    if mode == "--verify":
        for line in verify(copied, canon, rows):
            print(f"OK {line}")
        return

    verify(copied, canon, rows)
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "metadata": {
            "canonical_base_sha": CANON_BASE_SHA,
            "copied_base_sha": COPIED_BASE_SHA,
            "copied_file_count": len(copied),
            "canonical_file_count": len(canon),
            "hash_rule": HASH_RULE,
            "regenerate_command": REGENERATE_CMD,
            "generated_at_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        },
        "rows": rows,
    }
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
    write_md(rows, copied, canon)
    status_counts = {s: sum(1 for r in rows if r["status"] == s)
                     for s in ("identical", "diverged", "copied_only", "canonical_only")}
    print(f"wrote {OUT_JSON}")
    print(f"wrote {OUT_MD}")
    print("rows: " + " ".join(f"{s}={n}" for s, n in status_counts.items()) + f" total={len(rows)}")


if __name__ == "__main__":
    main()
