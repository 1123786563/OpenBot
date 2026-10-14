#!/usr/bin/env python3
"""Re-parse ticket-breakdown-v2.md (the approved source of truth) and sync
ticket-proposal-v2.json + docs/tickets/opik-4/manifest.json, preserving any
already-published GitHub issue numbers. Then re-run the DAG checks.
"""
import json, pathlib, re
from itertools import combinations

HERE = pathlib.Path(__file__).resolve().parent
md = (HERE / "ticket-breakdown-v2.md").read_text()
prop = json.loads((HERE / "ticket-proposal-v2.json").read_text())
pub = json.loads((HERE / "publication-v2.json").read_text())

parsed = {}
for m in re.finditer(r"\*\*(T\d\d) ([^\n]+)\*\*\n(.*?)(?=\n\*\*T\d\d |\n## |\Z)", md, re.S):
    tid, title, body = m.group(1), m.group(2).strip(), m.group(3)
    f = lambda k: (re.search(r"- " + k + r": (.+)", body) or [None, None])[1]
    bb = f("Blocked by") or ""
    if bb.lower().startswith("none"):
        deps = []
    else:
        rng = re.search(r"T(\d\d)\s*[–—-]\s*T(\d\d)", bb)
        if rng:  # "T01–T36（全部）" is a range, not two separate tickets
            deps = [f"T{n:02d}" for n in range(int(rng.group(1)), int(rng.group(2)) + 1)]
        else:
            deps = re.findall(r"T\d\d", bb)
        deps = [d for d in deps if d != tid]
    parsed[tid] = {
        "title": title, "depends_on": deps, "delivers": (f("Delivers") or "").strip(),
        "owned": (f("Owned") or "").strip(), "handoff": (f("Handoff") or "").strip(),
        "covers": re.findall(r"A\d+", f("Covers") or ""),
        "size": (f("Size") or "").strip(),
    }

assert len(parsed) == 37, len(parsed)
changed = []
for t in prop["tickets"]:
    p = parsed[t["id"]]
    if sorted(t["blocked_by"]) != sorted(p["depends_on"]):
        changed.append((t["id"], "blocked_by", t["blocked_by"], p["depends_on"]))
    t["blocked_by"] = p["depends_on"]
    if t["title"] != p["title"]:
        changed.append((t["id"], "title", t["title"], p["title"]))
        t["title"] = p["title"]; t["issue_title"] = f"[Opik {t['id']}] {p['title']}"
    t["delivers"] = p["delivers"]; t["covers"] = p["covers"]
    t["owned"] = p["owned"]; t["handoff"] = p["handoff"]; t["size"] = p["size"]
    t["blocked_by_issues"] = [pub["issues"][b]["number"] for b in p["depends_on"]]

# DAG re-validation
ids = [t["id"] for t in prop["tickets"]]
for t in prop["tickets"]:
    for d in t["blocked_by"]:
        assert d in ids, (t["id"], d)
indeg = {i: 0 for i in ids}; adj = {i: [] for i in ids}
for t in prop["tickets"]:
    for d in t["blocked_by"]:
        adj[d].append(t["id"]); indeg[t["id"]] += 1
q = [i for i in ids if indeg[i] == 0]; topo = []
while q:
    n = q.pop(0); topo.append(n)
    for m2 in adj[n]:
        indeg[m2] -= 1
        if indeg[m2] == 0: q.append(m2)
cycles = [i for i in ids if i not in topo]
pos = {t: i for i, t in enumerate(ids)}
order_ok = all(pos[d] < pos[t["id"]] for t in prop["tickets"] for d in t["blocked_by"])
cov = sorted({c for t in prop["tickets"] for c in t["covers"]}, key=lambda x: int(x[1:]))
orphans = [i for i in ids if i not in {d for t in prop["tickets"] for d in t["blocked_by"]} and i != "T37"]

prop["cycles"] = cycles
prop["acceptance_covered"] = len(cov)
prop["ticket_orphans_no_dependents"] = orphans
(HERE / "ticket-proposal-v2.json").write_text(json.dumps(prop, ensure_ascii=False, indent=1))

# contention analysis on normalized owned paths
ANCHORS = ("server/", "app/", "shared/", "agent-langgraph/", "supervisor/",
           "docker/", "tests/", "docs/", "scripts/", "worker/")
def norm(raw):
    out, last = [], None
    for item in raw.split("、"):
        e = re.split(r"（|\(| \+ ", item.strip())[0].strip().strip("`").strip()
        if not e: continue
        if e.startswith(ANCHORS) or e in {"bun.lock", ".env.example"}:
            last = e.rsplit("/", 1)[0] if "/" in e else None; out.append(e)
        elif re.fullmatch(r"[\w.$@\[\]-]+\.(tsx?|sql|json|md|yml|yaml)", e):
            out.append(f"{last}/{e}" if last else e)
        else:
            out.append(e)
    return out

owners = {}
for t in prop["tickets"]:
    for f in norm(t["owned"]):
        owners.setdefault(f, []).append(t["id"])

anc = {}
def ancestors(i):
    if i in anc: return anc[i]
    s = set()
    for d in next(t for t in prop["tickets"] if t["id"] == i)["blocked_by"]:
        s.add(d); s |= ancestors(d)
    anc[i] = s; return s
for i in ids: ancestors(i)

unsafe = []
for f, ow in owners.items():
    if len(ow) < 2: continue
    for a, b in combinations(sorted(ow), 2):
        if b not in ancestors(a) and a not in ancestors(b):
            unsafe.append((f, a, b))

sizes = {t["id"]: len(norm(t["owned"])) for t in prop["tickets"]}
print("=== DAG ===")
print("cycles:", cycles, "| file order topological:", order_ok, "| acceptance covered:", cov)
print("orphan tickets (no dependents, excluding T37):", orphans or "none")
print("immediate frontier:", [i for i in ids if not next(t for t in prop["tickets"] if t["id"] == i)["blocked_by"]])
print("\n=== SIZE ===")
print("owned files: max", max(sizes.values()), "avg", round(sum(sizes.values())/len(sizes), 1))
print("over 8:", {k: v for k, v in sizes.items() if v > 8})
print("\n=== CONTENTION ===")
print("files owned by >1 ticket:", sum(1 for v in owners.values() if len(v) > 1))
print("parallel-UNSAFE pairs:", len(unsafe))
for f, a, b in unsafe: print("   ", f, a, b)
print("\nchanges synced from breakdown:", changed or "none")
(HERE / "sync-report-v2.json").write_text(json.dumps({
    "cycles": cycles, "order_ok": order_ok, "orphans": orphans,
    "acceptance_covered": cov, "owned_max": max(sizes.values()),
    "owned_over_8": {k: v for k, v in sizes.items() if v > 8},
    "parallel_unsafe_pairs": [list(x) for x in unsafe], "changes": changed,
}, ensure_ascii=False, indent=1))
