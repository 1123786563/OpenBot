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

set -u

envsubst '${OPENBOT_PREVIEW_UPSTREAM},${OPENBOT_PREVIEW_TLS_SERVER_NAME}' \
  < /etc/nginx/templates/preview-tls.conf.template \
  > /etc/nginx/conf.d/preview-tls.conf

# The image's stock default server (plain :80) is not part of this topology.
rm -f /etc/nginx/conf.d/default.conf

# Through sh: no exec-bit dependency on the bind mount (same posture as the
# certs sidecar's healthcheck invocation).
sh /openbot-preview-tls/reload-watcher.sh &

echo "[openbot-preview-tls] nginx starting (TLS terminator for the preview origin)"
exec nginx -g "daemon off;"
