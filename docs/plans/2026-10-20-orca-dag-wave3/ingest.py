#!/usr/bin/env python3
"""orca-dag-wave3 R1-R2 ingestion: snapshot candidates, deps, tree membership, readiness.

Read-only against GitHub (gh api). Writes scope.json / dag.json / dry-run data
into this run directory. No dispatch, no labels, no issue writes.
"""
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = "1123786563/OpenBot"
RUN = Path(__file__).resolve().parent
ISSUES = RUN / "issues"
ISSUES.mkdir(parents=True, exist_ok=True)

# In-flight trees owned by other active runs/worktrees (excluded, do not claim):
IN_FLIGHT = {
    "mastra": {"root": 472, "issues": set(range(473, 489)),
               "why": "mastra-exec worktree controller run active (ledger live, ME01-05 done/in review)"},
    "heroui": {"root": 443, "issues": set(range(444, 459)),
               "why": "feat/heroui-v3-migration worktree + live OCR processes"},
    "plugin": {"root": 459, "issues": set(range(460, 472)),
               "why": "feat/plugin-package-market-v1 worktree + live OCR processes"},
}
ROOTS = [5, 6, 358, 368, 376]  # bifrost, multitenancy, craft-preview, billing, hindsight
MT_GROUPS = list(range(187, 207))  # second-level grouping parents under #6
# Opik #4 tree (37 tickets #7-43) was implemented+reviewed on side branch
# opik-integration-main (runs ab5804/8e2edd), never merged; run-all left it as a
# pending user adjudication. Not fresh-implementation candidates.
OPIK_PENDING = set(range(7, 44)) | {4}
SPEC_ROOTS = {5: "bf", 6: "mt", 358: "craft", 376: "hs", 368: "bp"}
TITLE_DOMAIN = (("Bifrost", "bf"), ("[计费支付", "bp"), ("[Craft", "craft"),
                ("[Hindsight", "hs"), ("[多租户", "mt"))
DELIVERED_LABEL = "agent:ready-for-review"
CANDIDATE_LABEL = "ready-for-agent"


def gh(*args, retries=2):
    for i in range(retries + 1):
        p = subprocess.run(["gh", "api", *args], capture_output=True, text=True)
        if p.returncode == 0:
            return json.loads(p.stdout)
        if i == retries:
            return {"__error__": p.stderr.strip()[:300]}
        time.sleep(1.5 * (i + 1))


def fetch_all_open():
    out = subprocess.run(
        ["gh", "issue", "list", "--repo", REPO, "--state", "open", "--limit", "500",
         "--json", "number,title,labels"], capture_output=True, text=True, check=True)
    return {i["number"]: {"title": i["title"],
                          "labels": [l["name"] for l in i["labels"]]}
            for i in json.loads(out.stdout)}


def snapshot(n):
    body = gh(f"repos/{REPO}/issues/{n}")
    deps = gh(f"repos/{REPO}/issues/{n}/dependencies/blocked_by")
    (ISSUES / f"{n}.json").write_text(json.dumps(body, ensure_ascii=False, indent=1))
    (ISSUES / f"{n}-blocked_by.json").write_text(
        json.dumps(deps, ensure_ascii=False, indent=1))
    return n, body, deps


def main():
    open_issues = fetch_all_open()
    print(f"open issues: {len(open_issues)}")

    in_flight_issues = set()
    for spec in IN_FLIGHT.values():
        in_flight_issues |= spec["issues"] | {spec["root"]}

    delivered, candidates, unlabeled, in_flight_hits, opik_pending = [], [], [], [], []
    for n, meta in sorted(open_issues.items()):
        labels = meta["labels"]
        if DELIVERED_LABEL in labels:
            delivered.append(n)
        elif CANDIDATE_LABEL not in labels:
            unlabeled.append(n)
        elif n in OPIK_PENDING:
            opik_pending.append(n)
        elif n in in_flight_issues:
            in_flight_hits.append(n)
        else:
            candidates.append(n)
    print(f"delivered(labeled): {len(delivered)}  in-flight-excluded: {len(in_flight_hits)}  "
          f"candidates: {len(candidates)}  opik-pending: {len(opik_pending)}  "
          f"unlabeled-open: {len(unlabeled)}")

    # Root tree membership (--paginate; first page is only 30)
    membership = {}
    for root in ROOTS + MT_GROUPS + [t["root"] for t in IN_FLIGHT.values()]:
        sub = gh("--paginate", f"repos/{REPO}/issues/{root}/sub_issues")
        nums = {s["number"] for s in sub} if isinstance(sub, list) else set()
        (ISSUES / f"root-{root}-sub_issues.json").write_text(json.dumps(sorted(nums)))
        for n in nums:
            membership.setdefault(n, []).append(root)

    # Snapshot candidates + deps in parallel
    deps_map, errors = {}, []
    with ThreadPoolExecutor(max_workers=8) as ex:
        for n, body, deps in ex.map(snapshot, candidates):
            if "__error__" in body or "__error__" in deps or not isinstance(deps, list):
                errors.append(n)
                continue
            deps_map[n] = [{"number": d.get("number"), "state": d.get("state"),
                            "title": (d.get("title") or "")[:60]}
                           for d in deps if isinstance(d, dict)]
    if errors:
        print(f"ERRORS (retry needed): {errors}")
        sys.exit(1)

    delivered_set, open_set = set(delivered), set(open_issues)
    nodes, edges = {}, []

    def domain_of(n, roots):
        for root, dom in ((5, "bf"), (6, "mt"), (358, "craft"), (376, "hs"), (368, "bp")):
            if root in roots:
                return dom
        if any(g in roots for g in MT_GROUPS):  # second-level MT grouping parent
            return "mt"
        title = open_issues[n]["title"]
        for prefix, dom in TITLE_DOMAIN:  # body-link-only tickets
            if title.startswith(prefix):
                return dom
        return "unrooted"

    for n in sorted(candidates):
        blockers = [d for d in deps_map[n]
                    if d["state"] == "open" and d["number"] not in delivered_set]
        external = [d for d in blockers if d["number"] not in open_set]
        roots = membership.get(n, [])
        nodes[n] = {
            "issue": n, "title": open_issues[n]["title"],
            "domain": domain_of(n, roots),
            "kind": "spec_aggregate" if n in SPEC_ROOTS else "ticket",
            "roots": roots, "deps": deps_map[n],
            "open_blockers": blockers, "external_blockers": external,
            "ready": not blockers,
            "state": "ready" if not blockers else "blocked",
        }
        for d in deps_map[n]:
            if d["number"] in nodes or d["number"] in set(candidates):
                edges.append({"from": d["number"], "to": n,
                              "condition": "business_verified", "explicit": True})

    ready = [n for n, v in nodes.items()
             if v["ready"] and v["kind"] == "ticket"]
    blocked = [n for n, v in nodes.items() if not v["ready"]]
    aggregates = [n for n, v in nodes.items() if v["kind"] == "spec_aggregate"]
    by_domain = {}
    for n in ready:
        by_domain.setdefault(nodes[n]["domain"], []).append(n)

    scope = {
        "repo": REPO, "mode": "open-backlog-wave3", "scope_revision": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "excluded_in_flight": {k: {"root": v["root"], "issues": sorted(v["issues"]),
                                   "why": v["why"]} for k, v in IN_FLIGHT.items()},
        "excluded_opik_side_branch": {
            "issues": sorted(opik_pending),
            "why": "implemented+reviewed on branch opik-integration-main (runs ab5804/8e2edd), "
                   "never merged; run-all pending_user adjudication"},
        "excluded_delivered_by_label": sorted(delivered),
        "unlabeled_open": sorted(unlabeled),
        "candidates": sorted(candidates), "ready": sorted(ready),
        "spec_aggregates": sorted(aggregates),
        "blocked": sorted(blocked), "domain_ready": {k: sorted(v) for k, v in by_domain.items()},
    }
    (RUN / "scope.json").write_text(json.dumps(scope, ensure_ascii=False, indent=1))
    dag = {"nodes": [nodes[n] for n in sorted(nodes)], "edges": edges,
           "in_flight": scope["excluded_in_flight"]}
    (RUN / "dag.json").write_text(json.dumps(dag, ensure_ascii=False, indent=1))

    print("\n== READY by domain ==")
    for d, ns in sorted(by_domain.items()):
        print(f"  {d}: {len(ns)} -> {ns}")
    print(f"\n== BLOCKED: {len(blocked)} ==")
    ext = {n: v["external_blockers"] for n, v in nodes.items() if v["external_blockers"]}
    print(f"with external blockers: {sorted(ext)}")
    for n in sorted(blocked)[:40]:
        v = nodes[n]
        print(f"  #{n} [{v['domain']}] <- {[(d['number'], d['state']) for d in v['open_blockers']]}")
    if len(blocked) > 40:
        print(f"  ... {len(blocked) - 40} more (see dag.json)")


if __name__ == "__main__":
    main()
