#!/usr/bin/env python3
"""Coordinator progress snapshot for the Opik frontier wave.

worker-list's projection can lag (it reported missing_status while the agents
were demonstrably live), so this reads the authoritative per-dispatch facts:
worker-read's status block plus the tail of each transcript.

Usage: python3 orca_wave_status.py [--json]
"""
import json, pathlib, subprocess, sys, time

ORCA = "/Applications/Orca.app/Contents/Resources/bin/orca"
WT = pathlib.Path("/Users/wuyongjun/orca/workspaces/OpenBot/opik-integration")
LEDGER = WT / "docs/plans/evidence/2026-10-14-opik/orca-frontier-wave.json"


def orca(args, timeout=240):
    if "--json" not in args:
        args = args + ["--json"]
    r = subprocess.run([ORCA] + args, capture_output=True, text=True, cwd=str(WT), timeout=timeout)
    if r.returncode != 0:
        return {"_error": r.stderr.strip()[:300]}
    try:
        return json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"_error": f"unparseable (rc=0): {r.stdout[:200]}"}


def tail_text(blocks, limit=420):
    out = []
    for b in blocks or []:
        if not isinstance(b, dict):
            continue
        kind = b.get("type")
        if kind == "text" and b.get("text"):
            out.append(b["text"].strip())
        elif kind in ("tool_use", "tool-use"):
            name = b.get("name") or b.get("toolName") or "tool"
            inp = json.dumps(b.get("input") or b.get("args") or {}, ensure_ascii=False)
            out.append(f"[tool {name}] {inp[:160]}")
        elif kind in ("tool_result", "tool-result"):
            txt = b.get("text") or b.get("content") or ""
            if isinstance(txt, list):
                txt = " ".join(str(x.get("text", "")) if isinstance(x, dict) else str(x) for x in txt)
            out.append(f"[result] {str(txt)[:160]}")
    joined = "\n".join(x for x in out if x)
    return joined[-limit:] if len(joined) > limit else joined


def main():
    led = json.loads(LEDGER.read_text())
    rows = []
    for tid, d in led["dispatches"].items():
        did = d["dispatch_id"]
        rd = orca(["orchestration", "worker-read", "--dispatch", did, "--source", "auto", "--limit", "12"])
        if "_error" in rd:
            print(f"!! {tid} worker-read error: {rd['_error']}", file=sys.stderr)
        res = rd.get("result", {})
        status = res.get("status") or {}
        msgs = (res.get("transcript") or {}).get("messages") or []
        last_assistant = next((m for m in reversed(msgs) if m.get("role") == "assistant"), None)
        rows.append({
            "ticket": tid,
            "issue": led["tasks"]["implementers"][tid]["issue"],
            "dispatch_id": did,
            "worker_state": status.get("worker"),
            "terminal": status.get("terminal"),
            "liveness": status.get("liveness"),
            "provider": res.get("provider"),
            "messages_read": len(msgs),
            "last_activity": (last_assistant or {}).get("timestamp"),
            "tail": tail_text((last_assistant or {}).get("blocks")) if last_assistant else "(no assistant turn yet)",
            "worktree": (d.get("worktree_path") or "").split("/")[-1],
        })
        time.sleep(0.2)

    # Run-level inbox state, and whether any Task settled.
    tasks = orca(["orchestration", "task-list", "--run", led["run_id"], "--brief"])
    if "_error" in tasks:
        print(f"!! task-list error: {tasks['_error']}", file=sys.stderr)
    trows = (tasks.get("result") or {}).get("tasks") or []
    by_status = {}
    for t in trows:
        by_status.setdefault(t.get("status"), []).append(str(t.get("id"))[-12:])

    if "--json" in sys.argv:
        print(json.dumps({"workers": rows, "tasks_by_status": by_status}, ensure_ascii=False, indent=1))
        return

    print(f"Run {led['run_id']}   snapshot {time.strftime('%H:%M:%S')}")
    print(f"tasks by status: {json.dumps(by_status, ensure_ascii=False)}")
    print()
    for r in rows:
        age = ""
        if r["last_activity"]:
            age = f"  last_turn={time.strftime('%H:%M:%S', time.localtime(r['last_activity'] / 1000))}"
        print(f"#{r['issue']} {r['ticket']}  {r['dispatch_id']}  {r['worktree']}")
        print(f"   liveness={r['liveness']} terminal={r['terminal']} worker={r['worker_state']} "
              f"provider={r['provider']} msgs={r['messages_read']}{age}")
        tail = (r["tail"] or "").replace("\n", "\n     ")
        print(f"   tail: {tail[:400]}")
        print()


if __name__ == "__main__":
    main()
