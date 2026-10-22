#!/bin/sh
# docker/compose/preview-tls/reload-watcher.sh — the reload.stamp CONSUMER (#412,
# AC2 seam made runnable). docker/compose/certs/reload.sh bumps the mtime of
# tls/reload.stamp after every certificate install/renewal; this script polls that
# mtime inside the terminator container and turns a bump into `nginx -s reload` —
# a SIGHUP: the listener, in-flight requests and websocket upgrades survive, and the
# next TLS accept already uses the new certificate. A reload, never a restart.
#
# Relation to OPENBOT_TLS_RELOAD_URL (docs/tls-certs.md, reload hooks): they are
# ALTERNATIVES — pick exactly one.
#   - This watcher: the terminator watches the shared TLS directory. Works for
#     nginx-style signal-reloaded proxies with no HTTP reload endpoint.
#   - OPENBOT_TLS_RELOAD_URL: the sidecar POSTs to the terminator's own reload
#     endpoint (Traefik/Caddy admin APIs, a managed balancer). For this reference
#     topology nginx has no such endpoint, so leave it UNSET when running this
#     watcher — otherwise the sidecar logs a harmless WARN per renewal.
#
# Strict POSIX sh: the nginx:alpine image has no bash.

set -u

STAMP="/etc/openbot/tls/reload.stamp"
POLL_SECONDS="${OPENBOT_PREVIEW_TLS_RELOAD_POLL_SECONDS:-15}"

log() {
  # Match the sidecar's log prefix convention (openbot-tls vs its consumer) so a
  # single Loki/tail query on "openbot-tls" finds both sides of the handoff.
  echo "[openbot-preview-tls] $*"
}

last="uninitialized"

log "watching $STAMP every ${POLL_SECONDS}s (reload.stamp mtime -> nginx -s reload)"

while :; do
  # busybox stat: seconds-precision mtime is enough — the sidecar's `touch` can
  # never land twice inside one second for distinct renewals that matter.
  cur="$(stat -c %Y "$STAMP" 2>/dev/null || echo missing)"

  if [ "$cur" != "$last" ]; then
    if [ "$cur" = "missing" ]; then
      # Before the first issuance there is no stamp (and no cert.pem either — nginx
      # cannot even start). Say it once per state change and keep polling.
      log "reload.stamp not present yet — waiting for the first issuance"
    elif [ "$last" = "uninitialized" ]; then
      # First sighting after this container's own start: nginx already loaded the
      # current files, nothing to reload. Just record the baseline.
      log "baseline reload.stamp mtime $cur recorded"
    else
      log "reload.stamp mtime $last -> $cur; reloading nginx"
      if nginx -t >/dev/null 2>&1 && nginx -s reload >/dev/null 2>&1; then
        # nginx -t guards a half-written cert/key pair: a failed reload leaves the
        # OLD certificate serving (the AC "old cert keeps serving" behavior) instead
        # of taking the listener down on a bad file.
        log "nginx reloaded; next TLS accept uses the new certificate"
      else
        log "WARN reload failed (nginx -t/reload nonzero) — old certificate still serving; next bump retries"
      fi
    fi
    last="$cur"
  fi

  sleep "$POLL_SECONDS"
done
