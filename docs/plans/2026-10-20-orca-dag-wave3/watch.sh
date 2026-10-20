#!/bin/bash
# orca-dag-wave3 watch.sh — 单轮监督：等一条 Delivery，分类处理
# exit 0: 仅心跳/通知，已 ack，继续
# exit 2: 出现 worker_done/escalation/question → 写 pending_message.json（不 ack），协调器接管
# exit 1: CLI 异常（记录后由 supervise 决定重试/停止）
DIR="$(cd "$(dirname "$0")" && pwd)"
ORCA=/Applications/Orca.app/Contents/Resources/bin/orca
RUN=run_dab21d1c168e

OUT=$($ORCA orchestration check --run "$RUN" --wait --timeout-ms 600000 --json 2>>"$DIR/watch.log")
rc=$?
if [ $rc -ne 0 ]; then
  echo "$(date +%T) check exit=$rc" >> "$DIR/watch.log"
  exit 1
fi
printf '%s' "$OUT" > "$DIR/last_check.json"

VERDICT=$(cd "$DIR" && python3 - <<'EOF'
import json
d = json.load(open('last_check.json'))
msgs = (d.get('result') or {}).get('messages') or []
action = [m for m in msgs if m.get('type') in ('worker_done', 'escalation', 'question')
          or m.get('subject') in ('worker_done', 'escalation', 'question', 'ask')]
if action:
    json.dump(action, open('pending_message.json', 'w'), ensure_ascii=False, indent=1)
    print('ACTION', len(action))
else:
    print('OK', [(m.get('type'), m.get('subject')) for m in msgs])
EOF
)

echo "$(date +%T) $VERDICT" >> "$DIR/watch.log"
if [[ "$VERDICT" == ACTION* ]]; then
  exit 2
fi
# 安全 ack：本 Delivery 只含心跳/通知
DELIV=$(python3 -c "import json;print(json.load(open('$DIR/last_check.json')).get('result',{}).get('deliveryId',''))" 2>/dev/null)
[ -n "$DELIV" ] && $ORCA orchestration check --run "$RUN" --ack "$DELIV" --json >> "$DIR/watch.log" 2>&1
exit 0
