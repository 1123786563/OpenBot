#!/usr/bin/env python3
"""Read back the published ticket graph from GitHub and verify it against the
approved v2 proposal. Evidence over claims: every check is an actual API read.
"""
import hashlib, json, pathlib, subprocess, time

HERE = pathlib.Path(__file__).resolve().parent
REPO = "1123786563/OpenBot"
PARENT = 4

state = json.loads((HERE / "publication-v2.json").read_text())
content = json.loads((HERE / "ticket-issue-content-v2.json").read_text())
proposal = json.loads((HERE / "ticket-proposal-v2.json").read_text())
by_id = {t["id"]: t for t in content["tickets"]}

def api(path):
    r = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{path}: {r.stderr.strip()[:300]}")
    return json.loads(r.stdout)

problems = []
checked = {"issues": 0, "labels": 0, "subissues": 0, "blocked_by_edges": 0, "links": 0}

# 1. parent untouched
parent = api(f"/repos/{REPO}/issues/{PARENT}")
sha = hashlib.sha256(parent["body"].encode()).hexdigest()
expected_sha = proposal["parent_issue"]["body_sha256"]
if sha != expected_sha:
    problems.append(f"parent #{PARENT} body changed: {sha} != {expected_sha}")
print(f"parent #{PARENT} body sha256 unchanged: {sha == expected_sha}")
print(f"parent sub_issues_summary: {parent.get('sub_issues_summary')}")

# 2. native sub-issues of parent
subs = api(f"/repos/{REPO}/issues/{PARENT}/sub_issues?per_page=100")
sub_numbers = sorted(i["number"] for i in subs)
expected_numbers = sorted(v["number"] for v in state["issues"].values())
if sub_numbers != expected_numbers:
    problems.append(f"sub-issues mismatch: missing={set(expected_numbers)-set(sub_numbers)} extra={set(sub_numbers)-set(expected_numbers)}")
checked["subissues"] = len(sub_numbers)
print(f"native sub-issues on parent: {len(sub_numbers)}/37 -> {sub_numbers == expected_numbers}")

# 3. each ticket issue: state, label, title, parent link, body links resolved
for tid, rec in sorted(state["issues"].items()):
    n = rec["number"]
    iss = api(f"/repos/{REPO}/issues/{n}")
    checked["issues"] += 1
    if iss["state"] != "open":
        problems.append(f"#{n} {tid} state={iss['state']}")
    labels = [l["name"] for l in iss["labels"]]
    if "ready-for-agent" in labels:
        checked["labels"] += 1
    else:
        problems.append(f"#{n} {tid} missing ready-for-agent (has {labels})")
    if iss["title"] != by_id[tid]["issue_title"]:
        problems.append(f"#{n} {tid} title mismatch: {iss['title']!r}")
    if iss.get("parent_issue_url", "").endswith(f"/issues/{PARENT}"):
        pass
    else:
        problems.append(f"#{n} {tid} parent_issue_url={iss.get('parent_issue_url')}")
    if "<!-- issue-link -->" in iss["body"]:
        problems.append(f"#{n} {tid} unresolved blocked-by placeholder in body")
    else:
        checked["links"] += 1
    time.sleep(0.12)

print(f"issues verified: {checked['issues']}/37  labels ok: {checked['labels']}/37  "
      f"bodies fully resolved: {checked['links']}/37")

# 4. native blocked_by edges
for t in proposal["tickets"]:
    tid = t["id"]
    n = state["issues"][tid]["number"]
    deps = api(f"/repos/{REPO}/issues/{n}/dependencies/blocked_by?per_page=100")
    got = sorted(d["number"] for d in deps)
    want = sorted(state["issues"][b]["number"] for b in t["blocked_by"])
    checked["blocked_by_edges"] += len(got)
    if got != want:
        problems.append(f"#{n} {tid} blocked_by mismatch: got={got} want={want}")
    time.sleep(0.12)

print(f"native blocked_by edges verified: {checked['blocked_by_edges']} "
      f"(expected {sum(len(t['blocked_by']) for t in proposal['tickets'])})")

# 5. no stray open issues from this run
allopen = api(f"/repos/{REPO}/issues?state=open&per_page=100")
stray = [i["number"] for i in allopen
         if i["number"] not in expected_numbers and i["number"] != PARENT
         and "pull_request" not in i and i["number"] != 5 and i["number"] != 6]
print(f"other open issues (not part of this breakdown): {sorted(stray)}")

out = {
    "verified_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "repository": REPO, "parent_issue": PARENT,
    "parent_body_sha256": sha, "parent_body_unmodified": sha == expected_sha,
    "issues_expected": 37, "issues_found": checked["issues"],
    "labels_ready_for_agent": checked["labels"],
    "native_subissues_on_parent": len(sub_numbers),
    "parent_sub_issues_summary": parent.get("sub_issues_summary"),
    "pagination": "all list reads use per_page=100 (GitHub default 30 truncated the first run)",
    "native_blocked_by_edges": checked["blocked_by_edges"],
    "bodies_fully_resolved": checked["links"],
    "issue_number_range": [min(expected_numbers), max(expected_numbers)],
    "problems": problems,
    "ok": not problems,
}
(HERE / "publication-verification-v2.json").write_text(json.dumps(out, ensure_ascii=False, indent=1))
print("\nPROBLEMS:", len(problems))
for p in problems[:20]:
    print("  -", p)
print("RESULT:", "PASS" if not problems else "FAIL")
