#!/bin/sh
# docker/compose/preview-tls/start.sh — container command for the reference TLS
# terminator: render the config, start the reload-watcher (background), run nginx
# in the foreground.
#
# Why render here instead of the image's envsubst startup script: that script only
# runs when the command starts with `nginx` (docker-entrypoint.sh's own guard), and
# this container's command is `sh start.sh` (it has a watcher to launch first). So
# the substitution is done here, explicitly, with the exact variable list — nginx's
# runtime variables ($host, $http_upgrade, …) are never touched.

# F4 (OCR R1): fail-closed — a failed render (missing/unreadable template, full
# disk) exits the container instead of leaving an empty conf for nginx to "start
# successfully" with no 443 listener (matches the header's posture). A
# non-positive POLL_SECONDS falls back to the default 15 (LOW-6; the watcher
# carries the same guard).
set -eu

POLL_SECONDS="${OPENBOT_PREVIEW_TLS_RELOAD_POLL_SECONDS:-15}"
case "$POLL_SECONDS" in
  ''|*[!0-9]*) POLL_SECONDS=15 ;;
  0|00|000|0000|00000) POLL_SECONDS=15 ;;
esac
# Same overflow cap as the watcher: a value too large for `sleep` is a tight
# loop in disguise. Length first so arithmetic never sees an oversized literal.
if [ "${#POLL_SECONDS}" -gt 5 ] || [ "$POLL_SECONDS" -gt 86400 ]; then
  POLL_SECONDS=15
fi
export OPENBOT_PREVIEW_TLS_RELOAD_POLL_SECONDS="$POLL_SECONDS"

if ! envsubst '${OPENBOT_PREVIEW_UPSTREAM},${OPENBOT_PREVIEW_TLS_SERVER_NAME}' \
  < /etc/nginx/templates/preview-tls.conf.template \
  > /etc/nginx/conf.d/preview-tls.conf; then
  echo "[openbot-preview-tls] FATAL: envsubst render failed — refusing to start nginx without a rendered 443 config (fail-closed)" >&2
  exit 1
fi

# The image's stock default server (plain :80) is not part of this topology.
rm -f /etc/nginx/conf.d/default.conf

# Through sh: no exec-bit dependency on the bind mount (same posture as the
# certs sidecar's healthcheck invocation).
sh /openbot-preview-tls/reload-watcher.sh &

echo "[openbot-preview-tls] nginx starting (TLS terminator for the preview origin)"
exec nginx -g "daemon off;"
