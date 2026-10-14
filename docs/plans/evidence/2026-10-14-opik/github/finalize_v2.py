#!/usr/bin/env python3
"""Write the real GitHub issue numbers back into the local evidence so the
worktree record matches what is actually published. Bodies are re-fetched from
GitHub rather than regenerated, so local == remote by construction.
"""
import json, pathlib, re, subprocess, time

HERE = pathlib.Path(__file__).resolve().parent
REPO = "1123786563/OpenBot"
PARENT = 4

state = json.loads((HERE / "publication-v2.json").read_text())
content = json.loads((HERE / "ticket-issue-content-v2.json").read_text())
proposal = json.loads((HERE / "ticket-proposal-v2.json").read_text())

def api(path):
    r = subprocess.run(["gh", "api", path], capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"{path}: {r.stderr.strip()[:300]}")
    return json.loads(r.stdout)

# 1. re-fetch bodies so local drafts are byte-identical to the published issues
num_by_id = {t: v["number"] for t, v in state["issues"].items()}
for t in content["tickets"]:
    rec = state["issues"][t["id"]]
    iss = api(f"/repos/{REPO}/issues/{rec['number']}")
    (HERE / t["draft_file"]).write_text(iss["body"])
    time.sleep(0.1)
print(f"re-fetched {len(content['tickets'])} published bodies into ticket-drafts-v2/")

# 2. ticket-proposal-v2.json -> published
for t in proposal["tickets"]:
    rec = state["issues"][t["id"]]
    t["github_issue"] = {"number": rec["number"], "id": rec["id"], "url": rec["url"]}
    t["issue_title"] = rec["title"]
    t["blocked_by_issues"] = [num_by_id[b] for b in t["blocked_by"]]
    t["status"] = "published_ready_for_agent"
proposal["stage"] = "spec_published; tickets_published_with_native_relationships"
proposal["published_at"] = state.get("published_at") or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
proposal["issue_number_range"] = [min(num_by_id.values()), max(num_by_id.values())]
proposal["native_subissues"] = len(num_by_id)
proposal["native_blocked_by_edges"] = len(state["blocked_by"])
proposal["verification"] = "publication-verification-v2.json (PASS, 0 problems)"
(HERE / "ticket-proposal-v2.json").write_text(json.dumps(proposal, ensure_ascii=False, indent=1))

# 3. draft-verification-v2.json -> published
dv = json.loads((HERE / "draft-verification-v2.json").read_text())
dv["revision"] = "v2"
dv["draft_count"] = 37
dv["native_children_published"] = 37
dv["native_blocked_by_edges_published"] = len(state["blocked_by"])
dv["issue_number_range"] = [min(num_by_id.values()), max(num_by_id.values())]
dv["issue_map"] = num_by_id
dv["awaiting"] = None
dv["published"] = True
dv["verification"] = json.loads((HERE / "publication-verification-v2.json").read_text())
(HERE / "draft-verification-v2.json").write_text(json.dumps(dv, ensure_ascii=False, indent=1))

# 4. breakdown md -> published, with the real issue map
md_path = HERE / "ticket-breakdown-v2.md"
md = md_path.read_text()
md = md.replace(
    "Status: draft awaiting user approval; child issues have not been published.",
    "Status: APPROVED by the user 2026-10-15 and PUBLISHED to GitHub. "
    "Child issues #%d–#%d are native sub-issues of the parent Spec with native blocked-by edges. "
    "Verified by `publication-verification-v2.json` (PASS, 0 problems)."
    % (min(num_by_id.values()), max(num_by_id.values())))
rows = "\n".join(
    f"| {t['id']} | #{num_by_id[t['id']]} | {t['title']} | "
    + (", ".join(f"#{num_by_id[b]}" for b in t["blocked_by"]) or "—") + " |"
    for t in content["tickets"])
md += ("\n\n## Published issue map\n\n"
       "Parent Spec: #%d (body and status unmodified; sha256 verified after publication).\n\n"
       "| Ticket | Issue | Title | Blocked by (native) |\n| --- | --- | --- | --- |\n%s\n"
       % (PARENT, rows))
md_path.write_text(md)

print("issue map: #%d..#%d  (37 tickets)" % (min(num_by_id.values()), max(num_by_id.values())))
print("wrote: ticket-proposal-v2.json, draft-verification-v2.json, ticket-breakdown-v2.md")
