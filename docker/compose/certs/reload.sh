#!/bin/sh
# docker/compose/certs/reload.sh — acme.sh's --reloadcmd (#359, AC8): runs inside the
# sidecar after --install-cert, i.e. on first issuance AND on every successful
# renewal. A reload, never a restart: the preview server keeps its listener and its
# in-flight connections/websocket upgrades, and picks the new certificate up on its
# next accept. Two mechanisms, both optional and both documented in docs/tls-certs.md:
#
#   1. tls/reload.stamp — mtime bump, the polling seam for the server-side watcher
#      (#362's consumer decides: watch the stamp, or re-stat cert.pem directly).
#   2. OPENBOT_TLS_RELOAD_URL — an http(s) POST to the server's own reload endpoint
#      (e.g. http://host.docker.internal:3001/... as wired by the server side). The
#      hook's failure is logged, never fatal: the certificate IS installed, only the
#      live reload needs attention, and the next renewal retries it.
#
# Also enforces the private-key permission floor every time files are rewritten:
# key 600, cert 644, and an optional chown to the server's uid:gid
# (OPENBOT_TLS_OWNER=uid:gid, honored when this container runs as root).

set -u
LIB_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
# shellcheck disable=SC1091
. "$LIB_DIR/lib.sh"

TLS_DIR="$(tls_dir)"

[ -f "$TLS_DIR/key.pem" ] && chmod 600 "$TLS_DIR/key.pem"
[ -f "$TLS_DIR/cert.pem" ] && chmod 644 "$TLS_DIR/cert.pem"
if [ -n "${OPENBOT_TLS_OWNER:-}" ] && [ "$(id -u)" = "0" ]; then
  # fix-ocr17: only an explicit uid:gid pair is honored — the old unconditional
  # assembly turned a bare uid "1000" into "1000:1000" and silently changed
  # the group. Anything else is a WARN + skip (owner_uid_gid answers empty).
  owner="$(owner_uid_gid "$OPENBOT_TLS_OWNER")"
  if [ -n "$owner" ]; then
    chown "$owner" "$TLS_DIR/key.pem" "$TLS_DIR/cert.pem" 2>/dev/null \
      || log "WARN chown to OPENBOT_TLS_OWNER=${OPENBOT_TLS_OWNER} failed"
  else
    log "WARN OPENBOT_TLS_OWNER=${OPENBOT_TLS_OWNER} is not uid:gid; skipping chown (group unchanged)"
  fi
fi

touch "$TLS_DIR/reload.stamp"
log "certificate installed/renewed; reload signalled (reload.stamp)"

if [ -n "${OPENBOT_TLS_RELOAD_URL:-}" ]; then
  now="$(date +%s)"
  if curl -fsS -m 10 -X POST "$OPENBOT_TLS_RELOAD_URL" -H 'content-type: application/json' \
    -d '{"source":"openbot-tls"}' >/dev/null 2>&1; then
    log "reload hook delivered: $OPENBOT_TLS_RELOAD_URL"
    # fix-ocr18 #11, honestly restated (fix-ocr20 #7): the hook's outcome is
    # VISIBLE in the status file — "certificate replaced but the reload
    # consumer absent" is no longer only a log line. What this field does NOT
    # have yet is a CONSUMER: neither the healthcheck nor the alert loop reads
    # lastReloadOk (an alerting semantic this script deliberately does not
    # invent), so a broken live-reload still surfaces only to whoever reads
    # renewal-status.json. Alert consumption and #362's server-side read of
    # the file are the same pending batch — renewal-guard.sh's TODO(consumer)
    # note and the key roster (scripts/tls-pipeline.test.ts, fix-ocr18 #13)
    # are where this field's reader is owed.
    status_set "$(tls_status_file)" lastReloadOk true
    status_set "$(tls_status_file)" lastReloadAt "$now"
  else
    # Failure is never fatal — the certificate IS installed; only the live
    # reload needs attention. The WARN stays, and now the field carries it.
    log "WARN reload hook $OPENBOT_TLS_RELOAD_URL failed — certificate is installed; the server reloads on its next signal/restart"
    status_set "$(tls_status_file)" lastReloadOk false
    status_set "$(tls_status_file)" lastReloadAt "$now"
  fi
fi
exit 0
