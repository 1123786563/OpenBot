#!/usr/bin/env python3
"""Repair the sub-issue hierarchy: Spec #6 -> 20 group epics -> 143 tickets.

The REST removal endpoint 404s for this repo, so removals go through the GraphQL `removeSubIssue`
mutation (batched, aliased). Additions use the REST POST that already works. Idempotent and resumable.
"""
import json, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = "1123786563/OpenBot"
OWNER, NAME = REPO.split("/")
PARENT = 6
published = json.loads((HERE / "published.json").read_text())
epics = json.loads((HERE / "epics.json").read_text())
tickets = json.loads((HERE / "manifest.json").read_text())["tickets"]
epic_of = {t["id"]: epics[t["group"]] for t in tickets}


def run(args, tries=6):
    for a in range(tries):
        r = subprocess.run(args, capture_output=True, text=True)
        err = (r.stderr or r.stdout).strip().replace("\n", " ")
        if r.returncode == 0:
            return True, r.stdout.strip()
        if any(k in err.lower() for k in ("tls", "timeout", "eof", "rate limit", "secondary", "connection reset")) and a < tries - 1:
            time.sleep(3 * (a + 1)); continue
        return False, err
    return False, "exhausted"


def gql(query, tries=5):
    for a in range(tries):
        r = subprocess.run(["gh", "api", "graphql", "-f", f"query={query}"], capture_output=True, text=True)
        if r.returncode == 0:
            return True, r.stdout.strip()
        err = (r.stderr or r.stdout).strip().replace("\n", " ")
        if any(k in err.lower() for k in ("tls", "timeout", "eof", "rate limit", "secondary")) and a < tries - 1:
            time.sleep(4 * (a + 1)); continue
        return False, err
    return False, "exhausted"


# 1. number -> (int id, node id)
info = {}
for page in range(1, 8):
    ok, out = run(["gh", "api", f"repos/{REPO}/issues?state=open&per_page=100&page={page}",
                   "--jq", ".[] | \"\\(.number) \\(.id) \\(.node_id)\""])
    if not ok or not out:
        break
    for line in out.splitlines():
        n, i, node = line.split()
        info[int(n)] = (int(i), node)
print(f"issues mapped: {len(info)}", flush=True)


def subs(number):
    ok, out = run(["gh", "api", "--paginate", f"repos/{REPO}/issues/{number}/sub_issues", "--jq", ".[].number"])
    return {int(x) for x in out.split()} if ok and out else set()


ticket_numbers = set(published.values())
epic_numbers = set(epics.values())

# 2. detach tickets hanging directly off the Spec (batched GraphQL removals)
direct = subs(PARENT)
to_remove = sorted(direct & ticket_numbers)
print(f"spec sub-issues={len(direct)} epics={len(direct & epic_numbers)} tickets_to_detach={len(to_remove)}", flush=True)
for i in range(0, len(to_remove), 20):
    batch = to_remove[i:i + 20]
    parts = [f'm{j}: removeSubIssue(input: {{issueId: "{info[PARENT][1]}", subIssueId: "{info[n][1]}"}}) {{ issue {{ number }} }}'
             for j, n in enumerate(batch)]
    ok, err = gql("mutation { " + " ".join(parts) + " }")
    if not ok:
        print(f"  batch {i} removal failed: {err[:200]}", flush=True)
    time.sleep(0.4)

# 3. attach epics to the Spec
direct = subs(PARENT)
for g, n in epics.items():
    if n in direct:
        continue
    ok, err = run(["gh", "api", f"repos/{REPO}/issues/{PARENT}/sub_issues", "-F", f"sub_issue_id={info[n][0]}"])
    if not ok and "already" not in err.lower():
        print(f"  epic {g} #{n} attach failed: {err[:180]}", flush=True)
    time.sleep(0.2)

# 4. attach tickets to their epic
attached = {n: subs(n) for n in sorted(epic_numbers)}
ok_count = fail = 0
for t in tickets:
    n, epic = published[t["id"]], epic_of[t["id"]]
    if n in attached.get(epic, set()):
        ok_count += 1; continue
    good, err = run(["gh", "api", f"repos/{REPO}/issues/{epic}/sub_issues", "-F", f"sub_issue_id={info[n][0]}"])
    if good or "already" in err.lower():
        ok_count += 1; attached.setdefault(epic, set()).add(n)
    else:
        fail += 1; print(f"  FAIL {t['id']} #{n} -> epic #{epic}: {err[:170]}", flush=True)
    time.sleep(0.15)

# 5. verify
spec_subs = subs(PARENT)
counts = {n: len(subs(n)) for n in sorted(epic_numbers)}
report = {
    "spec": f"https://github.com/{REPO}/issues/{PARENT}",
    "spec_sub_issues": len(spec_subs),
    "spec_sub_issues_are_exactly_the_20_epics": spec_subs == epic_numbers,
    "epics": {g: {"issue": n, "url": f"https://github.com/{REPO}/issues/{n}", "tickets": counts.get(n, 0)} for g, n in epics.items()},
    "tickets_linked_to_epics": ok_count,
    "tickets_failed": fail,
    "tickets_total": len(tickets),
    "expected_total_under_epics": sum(counts.values()),
}
(HERE / "hierarchy-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=1) + "\n")
print(json.dumps({k: v for k, v in report.items() if k != "epics"}, ensure_ascii=False, indent=1))
sys.exit(1 if fail or not report["spec_sub_issues_are_exactly_the_20_epics"] else 0)
