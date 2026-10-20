#!/usr/bin/env python3
"""Publish the 151 tickets to GitHub as issues under parent Spec #5.

Phases (each resumable, run in order):
  create     — create one issue per ticket in topological order, record number/url/node_id
  bodies     — re-render bodies so "Blocked by" uses real issue numbers, then update issues
  relations  — link every ticket as a sub-issue of #5 and set native blocked_by dependencies

Safety:
  --dry-run   plan only, no API writes
  --limit N   stop after N creations (staged publishing)
  --only ID   act on a single ticket id
  Retries with backoff on secondary rate limits; every API result is appended to publish-log.jsonl.
  Native dependency support is probed once; if unavailable, relations fall back to body text only
  (the body already lists Blocked by) and the fallback is recorded in the log.

Usage:
  python3 publish.py --dry-run
  python3 publish.py --phase create --limit 10
  python3 publish.py --phase all
"""
import json, os, subprocess, sys, time, collections

HERE = os.path.dirname(os.path.abspath(__file__))
MANIFEST = os.path.join(HERE, "manifest.json")
ISSUES = os.path.join(HERE, "issues")
LOG = os.path.join(HERE, "publish-log.jsonl")
REPO = "1123786563/OpenBot"
PARENT_NUMBER = 5
LABEL = "ready-for-agent"


def log(entry):
    entry["ts"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    print(f"[log] {entry.get('action')} {entry.get('ticket','')} {entry.get('ok','')} {entry.get('note','')[:160]}")


def load():
    with open(MANIFEST, encoding="utf-8") as f:
        return json.load(f)


def save(m):
    with open(MANIFEST, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=1)
        f.write("\n")


def gh(args, retries=5, dry=False):
    """Run a gh command; returns (ok, stdout, stderr). Retries on rate limits."""
    if dry:
        return True, "[dry-run]", ""
    for attempt in range(retries):
        p = subprocess.run(["gh"] + args, capture_output=True, text=True)
        err = (p.stderr or "") + (p.stdout or "")
        if p.returncode == 0:
            return True, p.stdout.strip(), ""
        low = err.lower()
        if "rate limit" in low or "secondary" in low or "abuse" in low or "timeout" in low:
            wait = 15 * (attempt + 1)
            log({"action": "backoff", "ok": False, "note": f"retry {attempt+1} in {wait}s: {err[:120]}"})
            time.sleep(wait)
            continue
        return False, p.stdout.strip(), err.strip()
    return False, "", "retries exhausted"


def topo(m):
    by = {t["id"]: t for t in m["tickets"]}
    order, seen = [], set()

    def visit(tid):
        if tid in seen:
            return
        for d in by[tid]["depends_on"]:
            visit(d)
        seen.add(tid)
        order.append(tid)

    for t in m["tickets"]:
        visit(t["id"])
    assert len(order) == len(m["tickets"]), "topological order incomplete (cycle?)"
    return order, by


def body_path(t):
    return os.path.join(ISSUES, f"{t['id']}-{t.get('slug', t['id'])}.md")


TITLE_FORMAT = os.environ.get("TICKET_TITLE_FORMAT", "plain")


def title(t):
    """plain: 'Bifrost 01.1 网关地址与连接配置持久化'
    bracket: '[Ticket 01.1] 网关地址与连接配置持久化'
    parent:  'Bifrost#5 · 01.1 网关地址与连接配置持久化'
    """
    if TITLE_FORMAT == "bracket":
        return f"[Ticket {t['id']}] {t['title']}"
    if TITLE_FORMAT == "parent":
        return f"Bifrost#{PARENT_NUMBER} \u00b7 {t['id']} {t['title']}"
    return f"Bifrost {t['id']} {t['title']}"


def select_groups(m, spec):
    """'01-07' or '01,02,05' -> set of group ids"""
    if not spec:
        return {t["group"] for t in m["tickets"]}
    out = set()
    for part in spec.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out |= {g for g in {t["group"] for t in m["tickets"]} if a <= g <= b}
        elif part:
            out.add(part)
    return out


def phase_create(m, args):
    order, by = topo(m)
    groups = select_groups(m, args.groups)
    todo = [tid for tid in order if not by[tid].get("issue_number") and by[tid]["group"] in groups]
    if args.only:
        todo = [t for t in todo if t == args.only]
    if args.limit:
        todo = todo[: args.limit]
    print(f"create: {len(todo)} issues to create (of {len(order)} total)")
    for i, tid in enumerate(todo, 1):
        t = by[tid]
        path = body_path(t)
        if not os.path.exists(path):
            log({"action": "create", "ticket": tid, "ok": False, "note": f"missing body {path}"})
            continue
        ok, out, err = gh([
            "issue", "create", "--repo", REPO, "--title", title(t),
            "--body-file", path, "--label", LABEL,
        ], dry=args.dry_run)
        if ok and not args.dry_run:
            url = out.strip().splitlines()[-1]
            number = int(url.rstrip("/").split("/")[-1])
            t["issue_number"], t["issue_url"] = number, url
            node, dbid = "", None
            ok2, out2, _ = gh(["issue", "view", str(number), "--repo", REPO, "--json", "id"], dry=False)
            if ok2:
                try:
                    node = json.loads(out2)["id"]
                except Exception:
                    node = ""
            ok3, out3, _ = gh(["api", f"repos/{REPO}/issues/{number}", "--jq", ".id"], dry=False)
            if ok3:
                try:
                    dbid = int(out3.strip())
                except Exception:
                    dbid = None
            t["issue_node_id"] = node
            t["issue_db_id"] = dbid
            save(m)
            log({"action": "create", "ticket": tid, "ok": True, "note": f"#{number} dbid={dbid} {url}"})
        elif args.dry_run:
            log({"action": "create", "ticket": tid, "ok": "dry", "note": title(t)})
        else:
            log({"action": "create", "ticket": tid, "ok": False, "note": err[:300]})
        time.sleep(1.0)
        if i % 25 == 0:
            print(f"  ...{i}/{len(todo)}")
    return m


def phase_bodies(m, args):
    """Re-render with real issue numbers, then update issue bodies."""
    sys.path.insert(0, HERE)
    import importlib
    render = importlib.import_module("render")
    m2 = render.load()
    m2["_by"] = {t["id"]: t for t in m2["tickets"]}
    os.makedirs(ISSUES, exist_ok=True)
    updated = 0
    groups = select_groups(m2, args.groups)
    for t in m2["tickets"]:
        if not t.get("steps") or not t.get("issue_number"):
            continue
        if t["group"] not in groups:
            continue
        path = body_path({**t, "id": t["id"]})
        with open(path, "w", encoding="utf-8") as f:
            f.write(render.render(m2, t))
        if args.dry_run:
            updated += 1
            continue
        ok, out, err = gh(["issue", "edit", str(t["issue_number"]), "--repo", REPO, "--body-file", path])
        log({"action": "body-update", "ticket": t["id"], "ok": ok, "note": (err or out)[:200]})
        updated += 1 if ok else 0
        time.sleep(0.6)
    print(f"bodies: re-rendered and updated {updated}")
    return m


def parent_db_id(m):
    ok, out, err = gh(["api", f"repos/{REPO}/issues/{PARENT_NUMBER}", "--jq", ".id"])
    if not ok:
        log({"action": "parent-lookup", "ok": False, "note": err[:200]})
        return None
    try:
        return int(out.strip())
    except Exception:
        return None


DEP_SHAPE = {"mode": None}  # cached: 'issue_id' | 'issue_number' | None(unsupported)


def ensure_db_id(t):
    if t.get("issue_db_id"):
        return t["issue_db_id"]
    ok, out, _ = gh(["api", f"repos/{REPO}/issues/{t['issue_number']}", "--jq", ".id"])
    if ok:
        try:
            t["issue_db_id"] = int(out.strip())
        except Exception:
            t["issue_db_id"] = None
    return t.get("issue_db_id")


def set_blocked_by(number, dep_ticket):
    """Try the supported request shape once, then reuse it."""
    if DEP_SHAPE["mode"] is None:
        ok, out, err = gh(["api", "-X", "GET", f"repos/{REPO}/issues/{number}/dependencies/blocked_by"])
        if not ok:
            DEP_SHAPE["mode"] = "unsupported"
            log({"action": "native-probe", "ok": False, "note": err[:200]})
            return False, "unsupported"
        log({"action": "native-probe", "ok": True, "note": "GET supported"})
    dep_num = dep_ticket.get("issue_number")
    dep_db = ensure_db_id(dep_ticket)
    attempts = []
    if DEP_SHAPE["mode"] in (None, "issue_id") and dep_db:
        attempts.append(("issue_id", ["-F", f"issue_id={dep_db}"]))
    if DEP_SHAPE["mode"] in (None, "issue_number") and dep_num:
        attempts.append(("issue_number", ["-F", f"issue_number={dep_num}"]))
    if DEP_SHAPE["mode"] == "unsupported":
        return False, "unsupported"
    last = ""
    for mode, field in attempts:
        ok, out, err = gh(["api", "-X", "POST", f"repos/{REPO}/issues/{number}/dependencies/blocked_by"] + field)
        if ok:
            DEP_SHAPE["mode"] = mode
            return True, mode
        last = err[:200]
    return False, last


def phase_relations(m, args):
    pid = None if args.dry_run else parent_db_id(m)
    if not args.dry_run and not pid:
        print("relations: cannot resolve parent database id; aborting phase")
        return m
    linked = deps = 0
    groups = select_groups(m, args.groups)
    for t in m["tickets"]:
        n = t.get("issue_number")
        if not n:
            continue
        if args.only and t["id"] != args.only:
            continue
        if t["group"] not in groups:
            continue
        # sub-issue link to parent (REST expects the integer database id)
        if not t.get("sub_issue_linked"):
            dbid = ensure_db_id(t)
            ok, out, err = gh(["api", "-X", "POST", f"repos/{REPO}/issues/{PARENT_NUMBER}/sub_issues",
                               "-F", f"sub_issue_id={dbid}"], dry=args.dry_run)
            if ok or args.dry_run:
                t["sub_issue_linked"] = True
                linked += 1
            else:
                log({"action": "sub-issue", "ticket": t["id"], "ok": False, "note": err[:220]})
            if not args.dry_run:
                save(m)
            time.sleep(0.5)
        # native blocked_by
        for d in t["depends_on"]:
            dt = next(x for x in m["tickets"] if x["id"] == d)
            if not dt.get("issue_number") and not dt.get("issue_db_id"):
                continue
            key = f"dep_{d}"
            if t.get("_linked", {}).get(key):
                continue
            ok, info = (True, "dry") if args.dry_run else set_blocked_by(n, dt)
            if ok:
                t.setdefault("_linked", {})[key] = True
                deps += 1
            else:
                log({"action": "blocked_by", "ticket": t["id"], "ok": False, "note": f"{d}: {info}"})
            if not args.dry_run:
                save(m)
            time.sleep(0.4)
    print(f"relations: sub-issues linked {linked}, blocked_by edges set {deps}, native={DEP_SHAPE['mode']}")
    return m


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--phase", default="all", choices=["create", "bodies", "relations", "all"])
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--only", default="")
    p.add_argument("--groups", default="", help="e.g. 01-07 or 01,02,05 (default: all)")
    args = p.parse_args()

    m = load()
    order, by = topo(m)
    pending = [t for t in m["tickets"] if not t.get("issue_number")]
    print(f"repo={REPO} parent=#{PARENT_NUMBER} label={LABEL}")
    print(f"tickets={len(m['tickets'])} pending_create={len(pending)} bodies={'issues/'} first={order[0]} last={order[-1]}")
    print(f"title format: {TITLE_FORMAT} -> e.g. {title(by[order[0]])}")
    if args.groups:
        sel = select_groups(m, args.groups)
        n_sel = sum(1 for t in m["tickets"] if t["group"] in sel)
        print(f"group filter: {args.groups} -> groups {sorted(sel)} ({n_sel} tickets)")
    if args.dry_run:
        print("DRY RUN — first 12 in publish order:")
        for tid in order[:12]:
            print(f"  {tid} {title(by[tid])} (blocked by: {','.join(by[tid]['depends_on']) or '—'})")
        est = len(pending)
        print(f"planned API writes ≈ {est} creates + {est} body edits + {est} sub-issue links + "
              f"{sum(len(t['depends_on']) for t in m['tickets'])} blocked_by edges")
    if args.phase in ("create", "all"):
        m = phase_create(m, args)
        save(m)
    if args.phase in ("bodies", "all"):
        m = phase_bodies(m, args)
    if args.phase in ("relations", "all"):
        m = phase_relations(m, args)
        save(m)
    save(m)
    print("done.")


if __name__ == "__main__":
    main()
