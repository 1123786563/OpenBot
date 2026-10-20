#!/usr/bin/env python3
"""Repair the sub-issue hierarchy: Spec #6 -> 20 epics -> 143 tickets.

GitHub's sub_issues listing is paginated (30/page), so the first pass only unlinked part of the tickets that
were attached directly to the Spec, and "Sub issue may only have one parent" blocked re-linking them. This
script paginates properly, removes every ticket from the Spec, and links each ticket to its group epic with
retries for transient TLS/network failures. Idempotent.
"""
import json, subprocess, sys, time, collections
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = "1123786563/OpenBot"
PARENT = 6
published = json.loads((HERE / "published.json").read_text())
epics = json.loads((HERE / "epics.json").read_text())
manifest = json.loads((HERE / "manifest.json").read_text())
tickets = manifest["tickets"]
epic_of = {t["id"]: epics[t["group"]] for t in tickets}


def run(args, tries=6, method=None):
    for a in range(tries):
        r = subprocess.run(args, capture_output=True, text=True)
        err = (r.stderr or r.stdout).strip().replace("\n", " ")
        if r.returncode == 0:
            return True, r.stdout.strip()
        transient = any(k in err.lower() for k in ("tls", "timeout", "eof", "rate limit", "secondary", "connection reset"))
        if transient and a < tries - 1:
            time.sleep(3 * (a + 1)); continue
        return False, err
    return False, "exhausted retries"


def sub_issues(number):
    ok, out = run(["gh", "api", "--paginate", f"repos/{REPO}/issues/{number}/sub_issues", "--jq", ".[].number"])
    if not ok:
        sys.exit(f"cannot list sub-issues of #{number}: {out[:300]}")
    return {int(x) for x in out.split()} if out else set()


def int_ids():
    ids = {}
    for page in range(1, 8):
        ok, out = run(["gh", "api", f"repos/{REPO}/issues?state=open&per_page=100&page={page}",
                       "--jq", ".[] | \"\\(.number) \\(.id)\""])
        if not ok or not out:
            break
        for line in out.splitlines():
            n, i = line.split(); ids[int(n)] = int(i)
    return ids


ids = int_ids()
print(f"integer ids: {len(ids)}", flush=True)
ticket_numbers = set(published.values())
epic_numbers = set(epics.values())

# 1. remove tickets that still hang directly off the Spec
direct = sub_issues(PARENT)
wrong = sorted((direct & ticket_numbers))
print(f"spec sub-issues: {len(direct)} (epics {len(direct & epic_numbers)}, tickets to unlink {len(wrong)})", flush=True)
for n in wrong:
    ok, err = run(["gh", "api", "-X", "DELETE", f"repos/{REPO}/issues/{PARENT}/sub_issues/{ids[n]}"])
    if not ok:
        print(f"  unlink #{n} failed: {err[:160]}", flush=True)
    time.sleep(0.15)

# 2. make sure every epic sits under the Spec
for gname, n in epics.items():
    if n in direct:
        continue
    ok, err = run(["gh", "api", f"repos/{REPO}/issues/{PARENT}/sub_issues", "-F", f"sub_issue_id={ids[n]}"])
    if not ok and "already" not in err.lower():
        print(f"  epic {gname} #{n} link failed: {err[:160]}", flush=True)
    time.sleep(0.15)

# 3. link each ticket under its epic
attached = {n: sub_issues(n) for n in sorted(epic_numbers)}
ok_count = fail = 0
for t in tickets:
    n, epic = published[t["id"]], epic_of[t["id"]]
    if n in attached.get(epic, set()):
        ok_count += 1; continue
    good, err = run(["gh", "api", f"repos/{REPO}/issues/{epic}/sub_issues", "-F", f"sub_issue_id={ids[n]}"])
    if good or "already" in err.lower():
        ok_count += 1; attached.setdefault(epic, set()).add(n)
    else:
        fail += 1; print(f"  FAIL {t['id']} #{n} -> #{epic}: {err[:160]}", flush=True)
    time.sleep(0.15)

# 4. verify
spec_subs = sub_issues(PARENT)
counts = {n: len(sub_issues(n)) for n in sorted(epic_numbers)}
report = {
    "spec_sub_issues": len(spec_subs),
    "spec_sub_issues_are_all_epics": spec_subs == epic_numbers,
    "epic_sub_issue_counts": {g: counts[n] for g, n in epics.items()},
    "tickets_linked": ok_count,
    "tickets_failed": fail,
    "tickets_total": len(tickets),
}
(HERE / "hierarchy-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n")
print(json.dumps(report, ensure_ascii=False, indent=1))
sys.exit(1 if fail or not report["spec_sub_issues_are_all_epics"] else 0)
