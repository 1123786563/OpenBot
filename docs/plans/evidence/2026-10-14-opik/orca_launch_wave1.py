#!/usr/bin/env python3
"""Launch the frontier wave: five implementer workers, one per ticket.

Placement: a stacked child worktree of the opik-integration worktree, git base
1123786563/opik-integration (the branch that carries the plans, the manifest and
the measured baseline). --agent claude. --model deliberately omitted so each
worker inherits the user's configured claude default.

If worker-start exits non-zero this script stops and does NOT relaunch: the
receipt's failedStage and residualResources decide recovery, per the
orchestration safety floor.
"""
import json, pathlib, subprocess, sys

ORCA = "/Applications/Orca.app/Contents/Resources/bin/orca"
WT = pathlib.Path("/Users/wuyongjun/orca/workspaces/OpenBot/opik-integration")
LEDGER = WT / "docs/plans/evidence/2026-10-14-opik/orca-frontier-wave.json"
BASE = "1123786563/opik-integration"
REPO_ID = "d6edf033-748a-4549-ae5a-e9efd34cef91"

ledger = json.loads(LEDGER.read_text())
FRONTIER = ["T01", "T02", "T03", "T05", "T06"]


def start(tid):
    impl = ledger["tasks"]["implementers"][tid]
    args = [
        "orchestration", "worker-start", "--json",
        "--run", ledger["run_id"],
        "--task", impl["task_id"],
        "--worktree", "new-child",
        "--repo", f"id:{REPO_ID}",
        "--base-branch", BASE,
        "--name", impl["worktree_name"],
        "--display-name", f"impl {tid} #{impl['issue']}",
        "--comment", f"Opik {tid} implementer; plan {impl['plan']}; base {BASE}",
        "--agent", "claude",
        "--setup", "run",
        "--timeout-ms", "600000",
    ]
    # Run from the opik worktree so `new-child` stacks under it, not under main.
    r = subprocess.run([ORCA] + args, capture_output=True, text=True, cwd=str(WT))
    return r


def main():
    only = sys.argv[1:] or FRONTIER
    for tid in [t for t in FRONTIER if t in only]:
        if tid in ledger.get("dispatches", {}):
            print(f"{tid}: already dispatched, skipping")
            continue
        r = start(tid)
        out = r.stdout.strip()
        if r.returncode != 0:
            print(f"\n!!! {tid} worker-start FAILED (exit {r.returncode}). NOT relaunching.", file=sys.stderr)
            print(r.stderr.strip()[:2000], file=sys.stderr)
            if out:
                try:
                    rec = json.loads(out)
                    print("failedStage:", json.dumps(rec.get("failedStage") or rec.get("result", {}).get("failedStage"), ensure_ascii=False), file=sys.stderr)
                    print("residualResources:", json.dumps(rec.get("residualResources") or rec.get("result", {}).get("residualResources"), ensure_ascii=False), file=sys.stderr)
                except json.JSONDecodeError:
                    print(out[:2000], file=sys.stderr)
            LEDGER.write_text(json.dumps(ledger, ensure_ascii=False, indent=1))
            print("\nLoad references/recovery-and-cleanup.md before any recovery action.", file=sys.stderr)
            sys.exit(1)

        rec = json.loads(out)
        res = rec.get("result", rec)
        dispatch_id = res.get("dispatchId")
        if not dispatch_id:
            print(f"!!! {tid}: start exited 0 but no dispatchId in receipt; keys={sorted(res.keys())}", file=sys.stderr)
            sys.exit(1)

        # The start receipt does not carry worktree/terminal facts in a stable shape.
        # worker-show --dispatch is the authoritative post-start read, so use it.
        show = subprocess.run([ORCA, "orchestration", "worker-show", "--dispatch", dispatch_id, "--json"],
                              capture_output=True, text=True, cwd=str(WT))
        if show.returncode != 0:
            print(f"!!! {tid}: worker-show failed for {dispatch_id}: {show.stderr.strip()[:400]}", file=sys.stderr)
            sys.exit(1)
        sr = json.loads(show.stdout)["result"]
        disp = sr.get("dispatch") or {}
        worker = sr.get("worker") or {}
        setup_effect = next((e for e in worker.get("effects", []) if e.get("kind") == "setup"), {})
        entry = {
            "dispatch_id": dispatch_id,
            "task_id": disp.get("taskId") or res.get("taskId"),
            "status": disp.get("status"),
            "worker_state": worker.get("state"),
            "worker_stage": worker.get("stage"),
            "terminal": worker.get("agentTerminalHandle"),
            "worktree_id": worker.get("worktreeId"),
            "worktree_path": (worker.get("worktreeId") or "").split("::", 1)[-1] or None,
            "setup_state": worker.get("setupState"),
            "setup_hook_found": setup_effect.get("hookFound"),
            "setup_startup_policy": setup_effect.get("startupPolicy"),
            "launch_requested": (res.get("launch") or {}).get("requested"),
            "launch_effective": (res.get("launch") or {}).get("effective"),
        }
        ledger.setdefault("dispatches", {})[tid] = entry
        LEDGER.write_text(json.dumps(ledger, ensure_ascii=False, indent=1))
        print(f"{tid}: dispatch={dispatch_id} status={entry['status']} worker={entry['worker_state']}/{entry['worker_stage']}")
        print(f"      worktree={entry['worktree_path']}")
        print(f"      terminal={entry['terminal']}")
        print(f"      setup={entry['setup_state']} hookFound={entry['setup_hook_found']} policy={entry['setup_startup_policy']}")
        print(f"      launch.effective={json.dumps(entry['launch_effective'], ensure_ascii=False)}")

    print(f"\nledger updated -> {LEDGER.relative_to(WT)}")
    print("dispatched:", sorted(ledger.get("dispatches", {})))


if __name__ == "__main__":
    main()
