#!/usr/bin/env python3
"""Refresh published issue bodies from the regenerated local ticket files (real Blocked-by links + epic line)."""
import json, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = "1123786563/OpenBot"
published = json.loads((HERE / "published.json").read_text())
tickets = json.loads((HERE / "manifest.json").read_text())["tickets"]
DONE = HERE / "bodies-synced.json"
done = set(json.loads(DONE.read_text())) if DONE.exists() else set()

for t in tickets:
    n = published.get(t["id"])
    if not n or t["id"] in done:
        continue
    body = (HERE / "tickets" / f"{t['id']}-{t['slug']}.md").read_text()
    tmp = HERE / ".tmp-sync.md"
    tmp.write_text(body)
    for attempt in range(5):
        r = subprocess.run(["gh", "issue", "edit", str(n), "--repo", REPO, "--body-file", str(tmp)],
                           capture_output=True, text=True)
        err = (r.stderr or r.stdout).strip().replace("\n", " ")
        if r.returncode == 0:
            done.add(t["id"])
            DONE.write_text(json.dumps(sorted(done), ensure_ascii=False, indent=0) + "\n")
            print(f"{t['id']} -> #{n} synced ({len(done)}/{len(tickets)})", flush=True)
            break
        if any(k in err.lower() for k in ("tls", "timeout", "eof", "rate limit", "secondary")) and attempt < 4:
            time.sleep(4 * (attempt + 1)); continue
        print(f"FAIL {t['id']} #{n}: {err[:200]}", flush=True)
        break
    tmp.unlink(missing_ok=True)
    time.sleep(0.25)

print(f"synced={len(done)}/{len(tickets)}")
sys.exit(0 if len(done) == len(tickets) else 1)
