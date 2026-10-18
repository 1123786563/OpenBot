#!/bin/bash
# MT122 AC4 static evidence: the entry business surface (context establishment,
# runtime config resolution, gate transaction) performs no external network
# dials. Comment-stripped source scan of every module in the seam's call graph,
# matching the network vocabulary set; any hit is printed with line numbers.
# Companion dynamic evidence: entry-context.test.ts wraps globalThis.fetch and
# counts dials across transaction()/runtimeConfig() (zero expected).
set -u
cd /Users/wuyongjun/orca/workspaces/OpenBot/i14-mt122/server || exit 1
FILES="
src/enterprise/tenancy/entry-context.ts
src/enterprise/tenancy/scope-gate.ts
src/enterprise/tenancy/runtime-config.ts
src/enterprise/tenancy/connections.ts
src/enterprise/tenancy/store.ts
src/enterprise/tenancy/global-exceptions.ts
"
python3 - "$FILES" <<'EOF'
import re, sys
NET = re.compile(
    r"\bfetch\s*\(|Bun\.connect|Bun\.listen|net\.connect|node:http|node:https|"
    r"node:net|node:tls|undici|XMLHttpRequest|new\s+WebSocket|axios|got\(|"
    r"https\.request|http\.request"
)
def strip_comments(src: str) -> str:
    out, i, n = [], 0, len(src)
    while i < n:
        c = src[i]
        if c == "/" and i + 1 < n and src[i + 1] == "/":
            while i < n and src[i] != "\n":
                i += 1
        elif c == "/" and i + 1 < n and src[i + 1] == "*":
            i += 2
            while i + 1 < n and not (src[i] == "*" and src[i + 1] == "/"):
                i += 1
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)

hits = 0
for path in sys.argv[1].split():
    try:
        code = strip_comments(open(path).read())
    except FileNotFoundError:
        print(f"MISSING: {path}")
        continue
    found = []
    for lineno, line in enumerate(code.splitlines(), 1):
        if NET.search(line):
            found.append(f"  {path}:{lineno}: {line.strip()[:100]}")
    if found:
        hits += len(found)
        print(f"HIT {path}:")
        print("\n".join(found))
    else:
        print(f"CLEAN {path}")
print(f"---")
print(f"network-vocabulary hits after comment stripping: {hits}")
sys.exit(1 if hits else 0)
EOF
