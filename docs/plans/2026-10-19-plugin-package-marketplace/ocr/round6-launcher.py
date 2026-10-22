#!/usr/bin/env python3
"""Detached round6 OCR launcher: waits for the provider quota reset
(2026-10-20 19:24:26 local) plus a 2-minute margin, then runs the full-range
OCR review at concurrency 4 so the 24 rate-limited items (incl. the 12
never-reviewed core service files) finally get covered. Double-fork + setsid
keeps it alive across session switches (round3 precedent)."""

import os
import subprocess
import sys
import time
from datetime import datetime

REPO = "/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market"
OUT = f"{REPO}/docs/plans/2026-10-19-plugin-package-marketplace/ocr/round6.json"
ERR = f"{REPO}/docs/plans/2026-10-19-plugin-package-marketplace/ocr/round6.stderr"
LAUNCH = f"{REPO}/docs/plans/2026-10-19-plugin-package-marketplace/ocr/round6.launch"
START_AT = "2026-10-20 19:26:30"


def detach() -> None:
    if os.fork() > 0:
        sys.exit(0)
    os.setsid()
    if os.fork() > 0:
        sys.exit(0)
    sys.stdout.flush()
    sys.stderr.flush()
    devnull = os.open(os.devnull, os.O_RDWR)
    os.dup2(devnull, 0)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)


def main() -> None:
    detach()
    with open(LAUNCH, "w") as fh:
        fh.write(f"pid={os.getpid()} start_at={START_AT} spawned={datetime.now().isoformat()}\n")
    target = datetime.strptime(START_AT, "%Y-%m-%d %H:%M:%S").timestamp()
    time.sleep(max(0.0, target - time.time()))
    with open(ERR, "ab") as eh, open(OUT, "wb") as oh:
        proc = subprocess.run(
            [
                "ocr", "review", "--audience", "agent", "--format", "json",
                "--concurrency", "4",
                "--exclude", "docs/plans/**,plugins/.artifacts/**",
            ],
            cwd=REPO,
            stdout=oh,
            stderr=eh,
        )
        eh.write(f"\nexit={proc.returncode} ended={datetime.utcnow().isoformat()}Z\n".encode())


if __name__ == "__main__":
    main()
