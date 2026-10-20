#!/usr/bin/env python3
"""Fold per-group detail files into manifest.json and validate completeness.

Detail files: docs/tickets/bifrost-5/details/group-NN.json
Shape:
{
  "group": "01",
  "context": ["docs/specs/...", "docs/adr/..."],
  "anchors": {"openbot": "...", "bifrost": "..."},
  "verification_common": ["bun run --filter server typecheck"],
  "tickets": {
    "01.1": {
      "slug": "gateway-endpoint-config",
      "contracts": {"consumes": ["..."], "produces": ["..."]},
      "steps": ["..."],
      "criteria": ["..."],
      "tests": ["..."],
      "verification": ["..."],
      "owned_scope": ["..."],
      "resume_hint": "..."
    }
  }
}
Usage: python3 merge_details.py [--strict]
"""
import json, os, re, sys, glob

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "manifest.json")
DETAILS = os.path.join(HERE, "details")
REQUIRED = ("contracts", "steps", "criteria", "tests", "verification", "owned_scope", "resume_hint", "slug")


def load_manifest():
    with open(MANIFEST, encoding="utf-8") as f:
        return json.load(f)


def save_manifest(m):
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
        f.write("\n")


def slugify(s):
    s = re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")
    return s or "ticket"


def merge(strict=False):
    m = load_manifest()
    by = {t["id"]: t for t in m["tickets"]}
    files = sorted(glob.glob(os.path.join(DETAILS, "group-*.json")))
    merged_groups = []
    problems = []
    for path in files:
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        gid = d["group"]
        merged_groups.append(gid)
        m.setdefault("group_context", {})[gid] = {
            "context": d.get("context", []),
            "anchors": d.get("anchors", {}),
            "verification_common": d.get("verification_common", []),
        }
        for tid, det in d["tickets"].items():
            if tid not in by:
                problems.append(f"{path}: unknown ticket id {tid}")
                continue
            t = by[tid]
            for k in REQUIRED:
                if k not in det or det[k] in ("", [], {}):
                    problems.append(f"{tid}: missing/empty {k}")
            t["slug"] = det.get("slug") or slugify(t["title"])
            for k in ("contracts", "steps", "criteria", "tests", "verification", "owned_scope", "resume_hint"):
                if k in det:
                    t[k] = det[k]
            t["detail_status"] = "complete" if not any(p.startswith(tid + ":") for p in problems) else "incomplete"
    # group ids present in manifest but not detailed yet
    all_groups = sorted({t["group"] for t in m["tickets"]})
    missing_groups = [g for g in all_groups if g not in merged_groups]
    detailed = sum(1 for t in m["tickets"] if t.get("steps"))
    m["detail_progress"] = {
        "tickets_detailed": detailed,
        "tickets_total": len(m["tickets"]),
        "groups_detailed": merged_groups,
        "groups_pending": missing_groups,
    }
    save_manifest(m)
    print(f"groups merged: {merged_groups}")
    print(f"groups pending: {missing_groups}")
    print(f"tickets detailed: {detailed}/{len(m['tickets'])}")
    if problems:
        print("PROBLEMS:")
        for p in problems:
            print(" -", p)
    if strict and (problems or missing_groups):
        sys.exit(1)


if __name__ == "__main__":
    merge(strict="--strict" in sys.argv)
