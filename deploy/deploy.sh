#!/usr/bin/env bash
set -euo pipefail
if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' '缺少 Python 3。Ubuntu/Debian 请先运行：sudo apt-get install python3' >&2
  exit 1
fi
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/platform.py" "$@"
