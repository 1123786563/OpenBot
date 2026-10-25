#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

read -r pid window_id < <(
  docker compose exec -T desktop cua-driver call list_windows |
    python3 -c 'import json, sys; windows = json.load(sys.stdin)["windows"]; matches = [w for w in windows if w["title"] == "OpenBot CUA + Guacamole"]; assert len(matches) == 1, "demo xterm window not found"; print(matches[0]["pid"], matches[0]["window_id"])'
)

docker compose exec -T desktop rm -f /tmp/cua-demo-result.txt
docker compose exec -T desktop cua-driver call get_window_state \
  "{\"pid\":$pid,\"window_id\":$window_id,\"session\":\"openbot-demo\"}" \
  --screenshot-out-file /tmp/cua-demo-before.png >/dev/null

docker compose exec -T desktop cua-driver call type_text \
  "{\"target\":{\"kind\":\"window\",\"pid\":$pid,\"window_id\":$window_id},\"x\":120,\"y\":110,\"text\":\"echo CUA_WORKED | tee /tmp/cua-demo-result.txt\",\"delivery_mode\":\"foreground\",\"session\":\"openbot-demo\"}"
docker compose exec -T desktop cua-driver call press_key \
  "{\"target\":{\"kind\":\"window\",\"pid\":$pid,\"window_id\":$window_id},\"key\":\"return\",\"delivery_mode\":\"foreground\",\"session\":\"openbot-demo\"}"

result=$(docker compose exec -T desktop cat /tmp/cua-demo-result.txt | tr -d '\r\n')
test "$result" = CUA_WORKED
docker compose exec -T desktop cua-driver call get_window_state \
  "{\"pid\":$pid,\"window_id\":$window_id,\"session\":\"openbot-demo\"}" \
  --screenshot-out-file /tmp/cua-demo-after.png >/dev/null

echo "CUA action verified: $result"
echo "Open http://127.0.0.1:18081/ to see the same xterm window in Guacamole."
