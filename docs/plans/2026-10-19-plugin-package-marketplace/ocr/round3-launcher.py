import os
import time

OCR_DIR = (
    "/Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market/"
    "docs/plans/2026-10-19-plugin-package-marketplace/ocr"
)
CMD = (
    "cd /Users/wuyongjun/trea/OpenBot/.worktrees/plugin-package-market && "
    "ocr review --audience agent --format json "
    f"> {OCR_DIR}/final-round3.json 2> {OCR_DIR}/final-round3.stderr; "
    f"echo \"exit=$? ended=$(date -u +%FT%TZ)\" >> {OCR_DIR}/final-round3.stderr"
)

pid = os.fork()
if pid == 0:
    os.setsid()
    with open(f"{OCR_DIR}/final-round3.launch", "w") as f:
        f.write(
            f"pid={os.getpid()} started={time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
            f"cmd=ocr review --audience agent --format json\n"
        )
    os.execvp("/bin/zsh", ["/bin/zsh", "-c", CMD])
else:
    print(f"detached round3 session pid={pid}")
