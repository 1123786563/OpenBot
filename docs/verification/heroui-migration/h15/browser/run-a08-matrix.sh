#!/bin/bash
# H15 A08 screenshot matrix — light/dark x zh/en x {1440x900,1280x720,390x844,320x568} over
# representative pages + 200% zoom + reduced-motion. Run from /tmp/cdp-harness.
set -u
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export H15_SHOTS="/Users/wuyongjun/trea/OpenBot/.worktrees/heroui-migration/docs/verification/heroui-migration/h15/screenshots"
S=/tmp/cdp-harness/cdp-sweep.mjs
PAGES=("/:home" "/settings/model-access:model-access" "/admin/gateway:admin-gateway" "/admin/billing:admin-billing" "/settings/usage:usage")

for theme in light dark; do
  for loc in zh en; do
    export SWEEP_THEME=$theme SWEEP_LOCALE=$loc
    # Desktop sizes on all pages
    export SWEEP_VIEWPORT='{"width":1440,"height":900}'
    for p in "${PAGES[@]}"; do
      path="${p%%:*}"; name="${p##*:}"
      node "$S" shot "$path" "${name}-${theme}-${loc}-1440.png" 2>&1 | grep -E "^shot|^PAGEERROR" &
    done
    wait
    export SWEEP_VIEWPORT='{"width":1280,"height":720}'
    node "$S" shot "/settings/model-access" "model-access-${theme}-${loc}-1280.png" 2>&1 | grep -E "^shot|^PAGEERROR"
    # Narrow screens
    export SWEEP_VIEWPORT='{"width":390,"height":844}'
    node "$S" shot "/" "home-${theme}-${loc}-390.png" 2>&1 | grep -E "^shot|^PAGEERROR"
    export SWEEP_VIEWPORT='{"width":320,"height":568}'
    node "$S" shot "/" "home-${theme}-${loc}-320.png" 2>&1 | grep -E "^shot|^PAGEERROR"
  done
done
# 200% zoom + reduced-motion (light+zh, desktop)
export SWEEP_THEME=light SWEEP_LOCALE=zh SWEEP_VIEWPORT='{"width":1440,"height":900}' SWEEP_ZOOM=2
node "$S" shot "/settings/model-access" "model-access-light-zh-1440-zoom200.png" 2>&1 | grep -E "^shot|^PAGEERROR"
node "$S" shot "/" "home-light-zh-1440-zoom200.png" 2>&1 | grep -E "^shot|^PAGEERROR"
unset SWEEP_ZOOM
export SWEEP_REDUCED=1
node "$S" shot "/" "home-light-zh-1440-reduced-motion.png" 2>&1 | grep -E "^shot|^PAGEERROR"
node "$S" shot "/admin/gateway" "admin-gateway-light-zh-1440-reduced-motion.png" 2>&1 | grep -E "^shot|^PAGEERROR"
echo DONE
