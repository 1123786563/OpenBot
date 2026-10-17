#!/usr/bin/env python3
"""Link every published ticket as a native GitHub sub-issue of the parent Spec.

The REST sub_issues endpoint wants the integer issue id (not the GraphQL node_id), sent as a typed
field. Idempotent: already-linked sub-issues are reported by the API and counted as linked.
"""
import json, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = "1123786563/OpenBot"
PARENT = 6
published = json.loads((HERE / "published.json").read_text())
manifest = json.loads((HERE / "manifest.json").read_text())

id_of = {}
for page in range(1, 8):
    out = subprocess.run(["gh", "api", f"repos/{REPO}/issues?state=open&per_page=100&page={page}",
                          "--jq", ".[] | \"\\(.number) \\(.id)\""], capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"fetch failed: {out.stderr[:400]}")
    if not out.stdout.strip():
        break
    for line in out.stdout.splitlines():
        n, i = line.split()
        id_of[int(n)] = int(i)
print(f"fetched integer ids for {len(id_of)} open issues", flush=True)

already = set()
cur = subprocess.run(["gh", "api", f"repos/{REPO}/issues/{PARENT}/sub_issues",
                      "--jq", ".[].number"], capture_output=True, text=True)
if cur.returncode == 0 and cur.stdout.strip():
    already = {int(x) for x in cur.stdout.split()}
print(f"already linked: {len(already)}", flush=True)

linked = skipped = failed = 0
for t in manifest["tickets"]:
    n = published.get(t["id"])
    if not n or n not in id_of:
        print(f"skip {t['id']}: number {n} not found in open issues"); skipped += 1; continue
    if n in already:
        linked += 1; continue
    r = subprocess.run(["gh", "api", f"repos/{REPO}/issues/{PARENT}/sub_issues",
                        "-F", f"sub_issue_id={id_of[n]}"], capture_output=True, text=True)
    if r.returncode == 0:
        linked += 1
    else:
        msg = (r.stderr or r.stdout).strip().replace("\n", " ")[:180]
        if "already" in msg.lower():
            linked += 1
        else:
            failed += 1
            print(f"FAIL {t['id']} #{n}: {msg}", flush=True)
    time.sleep(0.2)

print(f"\nlinked={linked} failed={failed} skipped={skipped} total={len(manifest['tickets'])}")
sys.exit(1 if failed or skipped else 0)
