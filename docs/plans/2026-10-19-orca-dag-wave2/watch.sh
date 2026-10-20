#!/bin/bash
set -uo pipefail
ORCA=/Applications/Orca.app/Contents/Resources/bin/orca
RUN=run_b7d44d543855
DIR="$(cd "$(dirname "$0")" && pwd)"
DEADLINE=$((SECONDS + 1680))
while [ $SECONDS -lt $DEADLINE ]; do
  $ORCA orchestration check --run $RUN --wait --types "worker_done,escalation,question,heartbeat" --timeout-ms 300000 --json > "$DIR/_check.json" 2>"$DIR/_check.err" || { sleep 20; continue; }
  eval $(python3 - "$DIR/_check.json" <<'PY'
import json, sys, shlex
d = json.load(open(sys.argv[1]))
r = d.get('result', {})
m = (r.get('messages') or [{}])[0]
print(f"did={shlex.quote(str(r.get('deliveryId','')))} mtype={shlex.quote(str(m.get('type','')))} cnt={r.get('count',0)}")
PY
)
  [ "$cnt" = "0" ] && continue
  if [ "$mtype" = "heartbeat" ]; then
    $ORCA orchestration check --run $RUN --ack "$did" --json >/dev/null 2>&1 || true
    echo "$(date +%T) ack heartbeat $did" >> "$DIR/watch.log"
    continue
  fi
  cp "$DIR/_check.json" "$DIR/pending_message.json"
  echo "$(date +%T) STOP: $mtype $did" >> "$DIR/watch.log"
  exit 2
done
exit 0
