#!/usr/bin/env python3
"""Publish the approved Opik v2 tickets to GitHub in topological order.

Resumable: progress is written to publication-v2.json after every successful
step, so a failure mid-run can be continued without duplicating issues.
"""
import json, pathlib, re, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
REPO = "1123786563/OpenBot"
PARENT = 4
LABEL = "ready-for-agent"
PROGRESS = HERE / "publication-v2.json"

content = json.loads((HERE / "ticket-issue-content-v2.json").read_text())
tickets = content["tickets"]

state = {"repository": REPO, "parent_issue": PARENT, "label": LABEL,
         "issues": {}, "subissues": [], "blocked_by": [], "errors": []}
if PROGRESS.exists():
    prev = json.loads(PROGRESS.read_text())
    state.update({k: prev[k] for k in state if k in prev})

def save():
    PROGRESS.write_text(json.dumps(state, ensure_ascii=False, indent=1))

def gh(args, input_text=None):
    r = subprocess.run(["gh"] + args, capture_output=True, text=True, input=input_text)
    if r.returncode != 0:
        raise RuntimeError(f"gh {' '.join(args[:4])}... failed: {r.stderr.strip()[:600]}")
    return r.stdout.strip()

def gh_api(method, path, body=None):
    args = ["api", "-X", method, path]
    if body is not None:
        args += ["--input", "-"]
    return gh(args, json.dumps(body) if body is not None else None)

def resolve_links(body, num_by_id):
    def repl(m):
        tid = m.group(1)
        n = num_by_id.get(tid)
        if not n:
            return m.group(0)
        return f"#{n}"
    out = re.sub(r"(T\d\d) ([^\n]*?)\s*<!-- issue-link -->",
                 lambda m: f"#{num_by_id[m.group(1)]} {m.group(2).strip()}"
                 if m.group(1) in num_by_id else m.group(0), body)
    return out

num_by_id = {t: v["number"] for t, v in state["issues"].items()}

for t in tickets:
    tid = t["id"]
    if tid in state["issues"]:
        print(f"{tid}: already published #{state['issues'][tid]['number']}")
        continue
    for b in t["blocked_by"]:
        if b not in num_by_id:
            print(f"FATAL: blocker {b} of {tid} not published yet", file=sys.stderr)
            save(); sys.exit(1)
    body = resolve_links(pathlib.Path(HERE / t["draft_file"]).read_text(), num_by_id)
    assert "<!-- issue-link -->" not in body, f"{tid}: unresolved blocked-by link"
    out = gh_api("POST", f"/repos/{REPO}/issues",
                 {"title": t["issue_title"], "body": body, "labels": [LABEL]})
    d = json.loads(out)
    state["issues"][tid] = {"number": d["number"], "id": d["id"],
                            "node_id": d["node_id"], "url": d["html_url"],
                            "title": t["issue_title"]}
    num_by_id[tid] = d["number"]
    save()
    print(f"{tid}: created #{d['number']} — {t['issue_title'][:52]}")
    time.sleep(0.4)

print("\n-- linking sub-issues to parent #%d --" % PARENT)
for t in tickets:
    tid = t["id"]
    if tid in state["subissues"]:
        continue
    iid = state["issues"][tid]["id"]
    try:
        gh_api("POST", f"/repos/{REPO}/issues/{PARENT}/sub_issues", {"sub_issue_id": iid})
        state["subissues"].append(tid); save()
        print(f"{tid}: sub-issue of #{PARENT} ok")
    except RuntimeError as e:
        state["errors"].append({"stage": "sub_issue", "ticket": tid, "error": str(e)})
        save(); print(f"{tid}: SUB-ISSUE FAILED {e}", file=sys.stderr)
    time.sleep(0.35)

print("\n-- linking native blocked_by --")
for t in tickets:
    tid = t["id"]
    for b in t["blocked_by"]:
        key = f"{tid}<-{b}"
        if key in state["blocked_by"]:
            continue
        n = state["issues"][tid]["number"]
        bid = state["issues"][b]["id"]
        bn = state["issues"][b]["number"]
        ok = False
        for payload in ({"issue_id": bid}, {"issue_number": bn}):
            try:
                gh_api("POST", f"/repos/{REPO}/issues/{n}/dependencies/blocked_by", payload)
                ok = True; break
            except RuntimeError as e:
                last = str(e)
        if ok:
            state["blocked_by"].append(key); save(); print(f"{key}: blocked_by ok")
        else:
            state["errors"].append({"stage": "blocked_by", "edge": key, "error": last})
            save(); print(f"{key}: BLOCKED_BY FAILED {last}", file=sys.stderr)
        time.sleep(0.35)

save()
print(f"\nDONE issues={len(state['issues'])} subissues={len(state['subissues'])} "
      f"blocked_by={len(state['blocked_by'])} errors={len(state['errors'])}")
